import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AgentHookServer, _internals } from '../../../agent-hook-server'
import { buildBody, PANE } from '../../server.test-fixtures'
import { recordInstalledCodexInterruptHook } from '../../../../../../shared/agent-hook-listener/providers/codex/codex-interrupt-hook-support'
import type * as AsyncRead from '../../../../../../shared/agent-hook-listener/providers/codex/codex-rollout-async-read'

// Every async rollout read goes through this gate: it counts reads in flight per file and can
// hold a result back after the bytes were read, which is how a slow open or a late read looks.
const reads = vi.hoisted(() => {
  const gated: {
    gate?: (filePath: string) => Promise<void>
    inFlight: Map<string, number>
    maxInFlight: number
    io: Set<Promise<unknown>>
  } = { inFlight: new Map(), maxInFlight: 0, io: new Set() }
  return gated
})

vi.mock(
  '../../../../../../shared/agent-hook-listener/providers/codex/codex-rollout-async-read',
  async (importOriginal) => {
    const actual = await importOriginal<typeof AsyncRead>()
    const gated =
      <A extends unknown[], R>(read: (...args: A) => Promise<R>, pathOf: (...args: A) => string) =>
      async (...args: A): Promise<R> => {
        const filePath = pathOf(...args)
        const count = (reads.inFlight.get(filePath) ?? 0) + 1
        reads.inFlight.set(filePath, count)
        reads.maxInFlight = Math.max(reads.maxInFlight, count)
        try {
          const io = read(...args)
          reads.io.add(io)
          const result = await io.finally(() => reads.io.delete(io))
          await reads.gate?.(filePath)
          return result
        } finally {
          reads.inFlight.set(filePath, (reads.inFlight.get(filePath) ?? 1) - 1)
        }
      }
    return {
      ...actual,
      readJsonlCursorAsync: gated(actual.readJsonlCursorAsync, (cursor) => cursor.filePath),
      readJsonlFirstRecordAsync: gated(actual.readJsonlFirstRecordAsync, (path) => path)
    }
  }
)

const ROOT_ID = '019fa65f-0000-7000-8000-000000000001'
const CHILD_ID = '019fa65f-0000-7000-8000-0000000000c1'
const GRANDCHILD_ID = '019fa65f-0000-7000-8000-0000000000c2'
const T1 = 'turn-1'
const T2 = 'turn-2'

const event = (payload: Record<string, unknown>): string =>
  `${JSON.stringify({ type: 'event_msg', payload })}\n`
const sessionMeta = (cliVersion: string): string =>
  `${JSON.stringify({ type: 'session_meta', payload: { id: ROOT_ID, cli_version: cliVersion } })}\n`
const childMeta = (id: string, agentPath: string): string =>
  `${JSON.stringify({
    type: 'session_meta',
    payload: { id, source: { subagent: { thread_spawn: { agent_path: agentPath } } } }
  })}\n`
const turnContext = (turnId: string, reviewer: 'user' | 'auto_review'): string =>
  `${JSON.stringify({ type: 'turn_context', payload: { turn_id: turnId, approvals_reviewer: reviewer } })}\n`
const taskStarted = (turnId: string): string => event({ type: 'task_started', turn_id: turnId })
const taskComplete = (turnId: string, error?: unknown): string =>
  event({ type: 'task_complete', turn_id: turnId, error: error ?? null })
const turnAborted = (turnId: string): string =>
  event({ type: 'turn_aborted', turn_id: turnId, reason: 'interrupted' })

const BASH = { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'call-1' }

type Row = ReturnType<AgentHookServer['getStatusSnapshot']>[number]

let server: AgentHookServer
let dir: string
let published: { state: string }[]

function rollout(name: string, ...lines: string[]): string {
  const path = join(dir, `rollout-${name}.jsonl`)
  writeFileSync(path, lines.join(''))
  return path
}

async function post(payload: Record<string, unknown>): Promise<void> {
  const env = server.buildPtyEnv()
  const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/codex`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Connection: 'close',
      'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
    },
    body: JSON.stringify(buildBody({ session_id: ROOT_ID, ...payload }))
  })
  expect(response.status).toBe(204)
}

function row(): Row | undefined {
  return server.getStatusSnapshot().find((entry) => entry.paneKey === PANE)
}

/** The status facts the sidebar shows, for comparing whole timelines and end states. */
function shown(entry: Row | undefined): Record<string, unknown> {
  return {
    state: entry?.state,
    interrupted: entry?.interrupted ?? false,
    outcome: entry?.mainAgent?.outcome,
    subagents: entry?.subagents?.map((child) => [child.description, child.state]) ?? []
  }
}

/** Let real file I/O finish and fake time run, so reads land and tails tick. */
async function settle(ms = 12_000): Promise<void> {
  const drainIo = async (): Promise<void> => {
    while (reads.io.size > 0) {
      await Promise.allSettled(reads.io)
      await vi.advanceTimersByTimeAsync(0)
    }
  }
  for (let elapsed = 0; elapsed < ms; elapsed += 250) {
    await drainIo()
    await vi.advanceTimersByTimeAsync(250)
  }
  await drainIo()
}

async function startServer(): Promise<void> {
  published = []
  server = new AgentHookServer()
  await server.start({ env: 'production' })
  server.setListener((entry) => {
    if (entry.paneKey === PANE && !entry.isReplay) {
      published.push({ state: entry.payload.state })
    }
  })
}

beforeEach(async () => {
  vi.useFakeTimers({
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance']
  })
  _internals.resetCachesForTests()
  reads.gate = undefined
  reads.inFlight.clear()
  reads.maxInFlight = 0
  recordInstalledCodexInterruptHook(undefined)
  dir = mkdtempSync(join(tmpdir(), 'codex-rollout-reads-'))
  await startServer()
})

afterEach(() => {
  server.stop()
  rmSync(dir, { recursive: true, force: true })
  vi.useRealTimers()
})

describe('Codex status from hooks, with async rollout reads only for what hooks lack', () => {
  it('tracks v2 and nested children from hooks and names them from their own rollout header', async () => {
    const root = rollout('root', sessionMeta('0.169.0'), taskStarted(T1))
    const child = rollout('child', childMeta(CHILD_ID, '/root/scout'))
    const grandchild = rollout('grandchild', childMeta(GRANDCHILD_ID, '/root/scout/deep'))
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
    await post({
      turn_id: 'child-turn',
      transcript_path: child,
      hook_event_name: 'SubagentStart',
      agent_id: CHILD_ID,
      agent_type: 'default'
    })
    await post({
      turn_id: 'grandchild-turn',
      transcript_path: grandchild,
      hook_event_name: 'SubagentStart',
      agent_id: GRANDCHILD_ID,
      agent_type: 'default'
    })
    await settle(1_000)
    expect(shown(row()).subagents).toEqual([
      ['scout', 'working'],
      ['scout/deep', 'working']
    ])

    // Codex names the immediate parent's rollout as a grandchild's SubagentStop transcript.
    await post({
      transcript_path: child,
      agent_transcript_path: grandchild,
      hook_event_name: 'SubagentStop',
      agent_id: GRANDCHILD_ID
    })
    await post({
      transcript_path: root,
      agent_transcript_path: child,
      hook_event_name: 'SubagentStop',
      agent_id: CHILD_ID
    })
    expect(shown(row()).subagents).toEqual([])
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'Stop' })
    expect(shown(row())).toEqual({
      state: 'done',
      interrupted: false,
      outcome: undefined,
      subagents: []
    })
  })

  it('ends a /review turn and a failed turn from the rollout, since Codex sends no Stop for either', async () => {
    const review = rollout('review', taskStarted(T1))
    await post({ turn_id: T1, transcript_path: review, hook_event_name: 'UserPromptSubmit' })
    await post({ turn_id: T1, transcript_path: review, hook_event_name: 'PreToolUse', ...BASH })
    appendFileSync(review, taskComplete(T1))
    await settle()
    expect(shown(row())).toEqual({
      state: 'done',
      interrupted: false,
      outcome: undefined,
      subagents: []
    })

    const failed = rollout('failed', taskStarted(T2))
    await post({ turn_id: T2, transcript_path: failed, hook_event_name: 'UserPromptSubmit' })
    appendFileSync(failed, taskComplete(T2, { message: 'model_not_found' }))
    await settle()
    expect(shown(row())).toEqual({
      state: 'done',
      interrupted: false,
      outcome: 'failure',
      subagents: []
    })
  })

  it('settles a cancel from Interrupt on Codex 0.150+, where a Ctrl+C copy leaves the turn running', async () => {
    const root = rollout('root', sessionMeta('0.169.0'), taskStarted(T1))
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'PreToolUse', ...BASH })
    // The hook, not the rollout, is the cancel: an abort record alone changes nothing on 0.150+.
    appendFileSync(root, turnAborted(T1))
    await settle()
    expect(row()?.state).toBe('working')
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'Interrupt' })
    expect(shown(row())).toEqual({
      state: 'done',
      interrupted: true,
      outcome: 'cancellation',
      subagents: []
    })

    appendFileSync(root, taskStarted(T2))
    await post({ turn_id: T2, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
    await post({ turn_id: T2, transcript_path: root, hook_event_name: 'PreToolUse', ...BASH })
    await settle()
    expect(row()?.state).toBe('working')
    await post({ turn_id: T2, transcript_path: root, hook_event_name: 'Stop' })
    expect(shown(row())).toEqual({
      state: 'done',
      interrupted: false,
      outcome: undefined,
      subagents: []
    })
  })

  it('cancels from the rollout on Codex before 0.150, which has no Interrupt hook', async () => {
    const root = rollout('root', sessionMeta('0.146.0'), taskStarted(T1))
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'PreToolUse', ...BASH })
    appendFileSync(root, turnAborted(T1))
    await settle()
    expect(shown(row())).toEqual({
      state: 'done',
      interrupted: true,
      outcome: 'cancellation',
      subagents: []
    })
  })

  it('skips the rollout cancel check when the installed Codex lists the Interrupt hook', async () => {
    recordInstalledCodexInterruptHook(true)
    const root = rollout('root', taskStarted(T1))
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
    appendFileSync(root, turnAborted(T1))
    await settle()
    expect(row()?.state).toBe('working')
  })

  it('classifies an approval at once from the reviewer its turn already read, then rechecks it', async () => {
    const root = rollout('root', taskStarted(T1), turnContext(T1, 'user'))
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
    await settle(500)
    await post({
      turn_id: T1,
      transcript_path: root,
      hook_event_name: 'PermissionRequest',
      ...BASH
    })
    expect(row()?.state).toBe('waiting')

    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'PostToolUse', ...BASH })
    appendFileSync(
      root,
      event({
        type: 'thread_settings_applied',
        thread_settings: { approvals_reviewer: 'auto_review' }
      })
    )
    await post({
      turn_id: T1,
      transcript_path: root,
      hook_event_name: 'PermissionRequest',
      ...BASH
    })
    await settle()
    expect(row()?.state).toBe('working')
  })

  it('never shows an approval Codex reviews itself as Needs you, and shows a user approval', async () => {
    const root = rollout('root', taskStarted(T1), turnContext(T1, 'auto_review'))
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'PreToolUse', ...BASH })
    await post({
      turn_id: T1,
      transcript_path: root,
      hook_event_name: 'PermissionRequest',
      ...BASH
    })
    await settle()
    expect(row()?.state).toBe('working')

    appendFileSync(root, turnContext(T1, 'user'))
    await post({
      turn_id: T1,
      transcript_path: root,
      hook_event_name: 'PermissionRequest',
      ...BASH
    })
    await settle()
    expect(row()?.state).toBe('waiting')
    expect(published.slice(0, -1).some((entry) => entry.state === 'waiting')).toBe(false)
  })
})

describe('Codex rollout read ordering', () => {
  it('holds a user approval as working until a read that started after it lands', async () => {
    let release: () => void = () => {}
    reads.gate = () => new Promise((resolve) => (release = resolve))
    const root = rollout('root', taskStarted(T1), turnContext(T1, 'auto_review'))
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
    // The reviewer changes after the prefetch read already started.
    appendFileSync(root, turnContext(T1, 'user'))
    await post({
      turn_id: T1,
      transcript_path: root,
      hook_event_name: 'PermissionRequest',
      ...BASH
    })
    expect(reads.inFlight.get(root)).toBe(1)
    expect(row()?.state).toBe('working')

    reads.gate = undefined
    release()
    await vi.waitFor(() => expect(row()?.state).toBe('waiting'))
    expect(reads.maxInFlight).toBe(1)
  })

  it('shows a held approval once its read is overdue, so a hung read cannot hide it', async () => {
    reads.gate = () => new Promise(() => {})
    const root = rollout('root', taskStarted(T1), turnContext(T1, 'user'))
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
    await post({
      turn_id: T1,
      transcript_path: root,
      hook_event_name: 'PermissionRequest',
      ...BASH
    })
    await vi.advanceTimersByTimeAsync(4_900)
    expect(row()?.state).toBe('working')
    await vi.advanceTimersByTimeAsync(200)
    expect(row()?.state).toBe('waiting')
  })

  it('drops a pre-0.150 abort read that lands after Stop and the next prompt', async () => {
    let release: () => void = () => {}
    reads.gate = () => new Promise((resolve) => (release = resolve))
    const root = rollout('root', sessionMeta('0.146.0'), taskStarted(T1), turnAborted(T1))
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'Stop' })
    await post({ turn_id: T2, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
    reads.gate = undefined
    release()
    await settle()
    expect(shown(row())).toEqual({
      state: 'working',
      interrupted: false,
      outcome: undefined,
      subagents: []
    })
  })

  it('re-reads, in the new turn, an abort read that started before the turn moved on', async () => {
    let release: () => void = () => {}
    reads.gate = () => new Promise((resolve) => (release = resolve))
    const root = rollout('root', sessionMeta('0.146.0'), taskStarted(T1), turnAborted(T1))
    // Hooks without turn ids leave only read order to tell the two turns apart.
    await post({ transcript_path: root, hook_event_name: 'UserPromptSubmit' })
    await post({ transcript_path: root, hook_event_name: 'Stop' })
    // Codex writes a turn's task_started before its UserPromptSubmit hook runs.
    appendFileSync(root, taskStarted(T2))
    await post({ transcript_path: root, hook_event_name: 'UserPromptSubmit' })
    reads.gate = undefined
    release()
    await settle()
    expect(shown(row())).toEqual({
      state: 'working',
      interrupted: false,
      outcome: undefined,
      subagents: []
    })
  })

  it('drops a child name read once the child has finished', async () => {
    let release: () => void = () => {}
    reads.gate = () => new Promise((resolve) => (release = resolve))
    const root = rollout('root', taskStarted(T1))
    const child = rollout('child', childMeta(CHILD_ID, '/root/scout'))
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
    await post({ transcript_path: child, hook_event_name: 'SubagentStart', agent_id: CHILD_ID })
    await post({ transcript_path: root, hook_event_name: 'SubagentStop', agent_id: CHILD_ID })
    reads.gate = undefined
    release()
    await settle()
    expect(shown(row()).subagents).toEqual([])
  })
})

/** Deterministic PRNG so a failing seed replays. */
function mulberry32(seed: number): () => number {
  let value = seed
  return () => {
    value = (value + 0x6d2b79f5) | 0
    let mixed = Math.imul(value ^ (value >>> 15), 1 | value)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** Hold each read result back 0-2 s of fake time, which settle() advances. */
function delayEachRead(random: () => number): () => Promise<void> {
  // ast-grep-ignore: test-no-real-time-wait -- runs on fake timers that settle() drives
  return () => new Promise((resolve) => setTimeout(resolve, random() * 2_000))
}

type Scenario = { name: string; run: () => Promise<void>; expected: Record<string, unknown> }

const SCENARIOS: Scenario[] = [
  {
    name: 'subagents still running',
    run: async () => {
      const root = rollout('root', sessionMeta('0.169.0'), taskStarted(T1))
      const child = rollout('child', childMeta(CHILD_ID, '/root/scout'))
      const grandchild = rollout('grandchild', childMeta(GRANDCHILD_ID, '/root/scout/deep'))
      await post({ turn_id: T1, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
      await post({ transcript_path: child, hook_event_name: 'SubagentStart', agent_id: CHILD_ID })
      await post({
        transcript_path: grandchild,
        hook_event_name: 'SubagentStart',
        agent_id: GRANDCHILD_ID
      })
      await post({
        transcript_path: grandchild,
        hook_event_name: 'PreToolUse',
        agent_id: GRANDCHILD_ID,
        ...BASH
      })
    },
    expected: {
      state: 'working',
      interrupted: false,
      outcome: undefined,
      subagents: [
        ['scout', 'working'],
        ['scout/deep', 'working']
      ]
    }
  },
  {
    name: 'user approval',
    run: async () => {
      const root = rollout('root', taskStarted(T1), turnContext(T1, 'user'))
      await post({ turn_id: T1, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
      await post({ turn_id: T1, transcript_path: root, hook_event_name: 'PreToolUse', ...BASH })
      await post({
        turn_id: T1,
        transcript_path: root,
        hook_event_name: 'PermissionRequest',
        ...BASH
      })
    },
    expected: { state: 'waiting', interrupted: false, outcome: undefined, subagents: [] }
  },
  {
    name: 'auto-reviewed approval',
    run: async () => {
      const root = rollout('root', taskStarted(T1), turnContext(T1, 'auto_review'))
      await post({ turn_id: T1, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
      await post({ turn_id: T1, transcript_path: root, hook_event_name: 'PreToolUse', ...BASH })
      await post({
        turn_id: T1,
        transcript_path: root,
        hook_event_name: 'PermissionRequest',
        ...BASH
      })
    },
    expected: { state: 'working', interrupted: false, outcome: undefined, subagents: [] }
  },
  {
    name: 'failed turn',
    run: async () => {
      const root = rollout('root', taskStarted(T1))
      await post({ turn_id: T1, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
      appendFileSync(root, taskComplete(T1, { message: 'model_not_found' }))
    },
    expected: { state: 'done', interrupted: false, outcome: 'failure', subagents: [] }
  },
  {
    name: '/review',
    run: async () => {
      const review = rollout('review', taskStarted(T1))
      await post({ turn_id: T1, transcript_path: review, hook_event_name: 'UserPromptSubmit' })
      await post({ turn_id: T1, transcript_path: review, hook_event_name: 'PreToolUse', ...BASH })
      await post({ turn_id: T1, transcript_path: review, hook_event_name: 'PostToolUse', ...BASH })
      appendFileSync(review, taskComplete(T1))
    },
    expected: { state: 'done', interrupted: false, outcome: undefined, subagents: [] }
  },
  {
    name: 'pre-0.150 cancel, then a new prompt',
    run: async () => {
      const root = rollout('root', sessionMeta('0.146.0'), taskStarted(T1))
      await post({ turn_id: T1, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
      await post({ turn_id: T1, transcript_path: root, hook_event_name: 'PreToolUse', ...BASH })
      appendFileSync(root, turnAborted(T1))
      await post({ turn_id: T2, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
      appendFileSync(root, taskStarted(T2))
      await post({ turn_id: T2, transcript_path: root, hook_event_name: 'PreToolUse', ...BASH })
    },
    expected: { state: 'working', interrupted: false, outcome: undefined, subagents: [] }
  },
  {
    name: 'cancel, then a Ctrl+C copy turn',
    run: async () => {
      const root = rollout('root', sessionMeta('0.169.0'), taskStarted(T1))
      await post({ turn_id: T1, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
      appendFileSync(root, turnAborted(T1))
      await post({ turn_id: T1, transcript_path: root, hook_event_name: 'Interrupt' })
      await post({ turn_id: T2, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
      appendFileSync(root, taskStarted(T2))
      await post({ turn_id: T2, transcript_path: root, hook_event_name: 'PreToolUse', ...BASH })
      appendFileSync(root, taskComplete(T2))
      await post({ turn_id: T2, transcript_path: root, hook_event_name: 'Stop' })
    },
    expected: { state: 'done', interrupted: false, outcome: undefined, subagents: [] }
  }
]

describe('Codex rollout reads under random delays', () => {
  for (const scenario of SCENARIOS) {
    it(`ends "${scenario.name}" the same however late each read lands`, async () => {
      for (let seed = 1; seed <= 12; seed += 1) {
        const random = seed === 1 ? () => 0 : mulberry32(seed)
        reads.gate = delayEachRead(random)
        await scenario.run()
        await settle()
        expect({ seed, ...shown(row()) }).toEqual({ seed, ...scenario.expected })
        if (scenario.name === 'auto-reviewed approval') {
          expect(published.some((entry) => entry.state === 'waiting')).toBe(false)
        }
        server.stop()
        _internals.resetCachesForTests()
        await startServer()
      }
    })
  }
})
