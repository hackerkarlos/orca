import type { AgentHookEventPayload } from '../../listener-event'
import type { HookListenerState } from '../../listener-state'
import { transcriptPollUpdate } from '../../transcript-poll-policy'
import { readJsonlCursorAsync, readJsonlFirstRecordAsync } from './codex-rollout-async-read'
import { codexApprovalHoldDeadline, codexRolloutStatus } from './codex-rollout-status'
import { getOrCreateCodexRolloutState } from './codex-state'
import { record } from './codex-rollout-jsonl-cursor'
import { parsePaneKey } from '../../../workspace-layout/stable-pane-id'
import {
  commitCodexRolloutRead,
  followCodexChildRollout,
  type CodexRolloutFile,
  type CodexRolloutState
} from './codex-rollout-state'
import { isCodexStatusTranscriptLine } from './codex-status-transcript-line'
import {
  applyCodexSubagentIdentityRead,
  nextCodexSubagentIdentityRetry,
  takeCodexSubagentIdentityReads,
  type CodexSubagentRoster
} from './codex-subagent-roster'

export type CodexRolloutHookContext = { body: unknown; env?: string; version?: string }

type PaneFollow = CodexRolloutHookContext & {
  /** Current pane key; a pane move re-keys it so reads in flight land on the new pane. */
  key: string
  wake?: ReturnType<typeof setTimeout>
  wakeAt?: number
}

export type CodexRolloutFollowerHost = {
  state: HookListenerState
  env: () => string
  listening: () => boolean
  /** Store a restated row; the host re-arms its tail from what it stored. */
  publish: (update: AgentHookEventPayload, context: CodexRolloutHookContext) => void
}

/**
 * Hooks own Codex status. This reads only what they lack (child names, approvals reviewer,
 * /review and failed-turn ends, pre-0.150 cancels), always through fs.promises so a slow open
 * delays that one fact and never the event loop. Ordering rules:
 * - one read in flight per file; a request made meanwhile reads again once it lands;
 * - a root read is dropped whole if the turn moved on while it ran (see CodexRolloutState.epoch);
 * - a child's own rollout ends it only if no hook for that child arrived after the read started;
 * - a name read is dropped once its child's session is gone;
 * - a held approval yields only to its own PostToolUse or the turn moving on (CodexApprovalHold);
 * - results publish against the row current when they land, never the row that started them;
 * - a pane move carries reads in flight, holds and the wake timer to the new pane key.
 */
export class CodexRolloutFollower {
  private readonly panes = new Map<string, PaneFollow>()

  constructor(private readonly host: CodexRolloutFollowerHost) {}

  /** After each stored Codex hook: start the reads it asked for. */
  observe(paneKey: string, context: CodexRolloutHookContext): void {
    const pane = this.panes.get(paneKey)
    if (pane) {
      Object.assign(pane, context)
    } else {
      this.panes.set(paneKey, { ...context, key: paneKey })
    }
    this.pump(paneKey, false)
  }

  /** A tail tick from the watch-driven scheduler while a root turn is open or children are live. */
  tail(paneKey: string): void {
    this.pump(paneKey, true)
  }

  /** Follow a pane to its new key, keeping reads in flight, held approvals and their timer. */
  move(fromPaneKey: string, toPaneKey: string): void {
    const pane = this.panes.get(fromPaneKey)
    if (!pane || fromPaneKey === toPaneKey) {
      return
    }
    this.clear(toPaneKey)
    this.panes.delete(fromPaneKey)
    if (pane.wake) {
      clearTimeout(pane.wake)
    }
    pane.wake = undefined
    pane.wakeAt = undefined
    pane.key = toPaneKey
    // A rollout-derived Stop is built from this envelope, so it must name the destination pane.
    const envelope = record(pane.body)
    if (envelope) {
      pane.body = {
        ...envelope,
        paneKey: toPaneKey,
        tabId: parsePaneKey(toPaneKey)?.tabId ?? envelope.tabId
      }
    }
    this.panes.set(toPaneKey, pane)
    this.pump(toPaneKey, false)
  }

  clear(paneKey: string): void {
    const pane = this.panes.get(paneKey)
    if (pane?.wake) {
      clearTimeout(pane.wake)
    }
    this.panes.delete(paneKey)
  }

  clearAll(): void {
    for (const pane of this.panes.values()) {
      if (pane.wake) {
        clearTimeout(pane.wake)
      }
    }
    this.panes.clear()
  }

  private pump(paneKey: string, tail: boolean): void {
    const pane = this.panes.get(paneKey)
    if (!pane) {
      return
    }
    const state = this.host.state
    const roster = state.codexSubagentRosterByPaneKey.get(paneKey)
    let rollout = state.codexRolloutByPaneKey.get(paneKey)
    if (tail && roster) {
      for (const [id, child] of roster) {
        if (child.rolloutPath) {
          rollout ??= getOrCreateCodexRolloutState(state, paneKey)
          followCodexChildRollout(rollout, id, child.rolloutPath)
        }
      }
    }
    if (rollout?.root && (tail || rollout.root.wanted > rollout.root.resolved)) {
      this.readRollout(pane, rollout, rollout.root)
    }
    for (const file of rollout?.childFiles.values() ?? []) {
      if (file.wanted > file.resolved || (tail && file.childId)) {
        this.readRollout(pane, rollout!, file)
      }
    }
    if (roster) {
      for (const { id, filePath } of takeCodexSubagentIdentityReads(roster, Date.now())) {
        this.readIdentity(pane, roster, id, filePath)
      }
    }
    this.armWake(paneKey)
  }

  private readRollout(pane: PaneFollow, rollout: CodexRolloutState, file: CodexRolloutFile): void {
    if (file.reading) {
      file.readAgain = true
      return
    }
    file.reading = true
    const asRoot = rollout.root === file
    const epoch = rollout.epoch
    const satisfies = file.wanted
    const childHooks = new Map(
      Array.from(
        this.host.state.codexSubagentRosterByPaneKey.get(pane.key) ?? [],
        ([id, child]) => [id, child.hooks] as const
      )
    )
    // A pure tail tick may skip the open; a waiting request reads straight away.
    void readJsonlCursorAsync(file.cursor, isCodexStatusTranscriptLine, {
      skipUnchanged: satisfies <= file.resolved
    })
      .then((read) => {
        file.reading = false
        const paneKey = pane.key
        const attached =
          this.host.state.codexRolloutByPaneKey.get(paneKey) === rollout &&
          (asRoot ? rollout.root === file : rollout.childFiles.get(file.cursor.filePath) === file)
        const current = attached && (!asRoot || rollout.epoch === epoch)
        if (current) {
          commitCodexRolloutRead(rollout, file, read, satisfies, childHooks, Date.now())
        }
        if (attached && file.readAgain) {
          file.readAgain = false
          this.readRollout(pane, rollout, file)
        }
        if (current) {
          this.publish(paneKey)
        }
      })
      .catch((error: unknown) => {
        file.reading = false
        console.error('[agent-hooks] Codex rollout read failed:', error)
      })
  }

  private readIdentity(
    pane: PaneFollow,
    roster: CodexSubagentRoster,
    id: string,
    filePath: string
  ): void {
    void readJsonlFirstRecordAsync(filePath)
      .then((head) => {
        // Applied to the roster that asked even if its pane moved; a finished child drops it.
        if (applyCodexSubagentIdentityRead(roster, id, filePath, head, Date.now())) {
          this.publish(pane.key)
        }
        // More queued children than one pass reads continue without waiting for a hook.
        this.pump(pane.key, false)
      })
      .catch((error: unknown) => {
        console.error('[agent-hooks] Codex child name read failed:', error)
      })
  }

  /** One timer per pane, for the next approval-hold deadline or deferred name read. */
  private armWake(paneKey: string): void {
    const pane = this.panes.get(paneKey)
    if (!pane) {
      return
    }
    const state = this.host.state
    const dues = [
      codexApprovalHoldDeadline(state, paneKey),
      nextCodexSubagentIdentityRetry(state.codexSubagentRosterByPaneKey.get(paneKey))
    ].filter((due): due is number => due !== undefined)
    const wakeAt = dues.length > 0 ? Math.min(...dues) : undefined
    if (pane.wakeAt === wakeAt) {
      return
    }
    if (pane.wake) {
      clearTimeout(pane.wake)
    }
    pane.wake = undefined
    pane.wakeAt = wakeAt
    if (wakeAt === undefined) {
      return
    }
    pane.wake = setTimeout(
      () => {
        pane.wake = undefined
        pane.wakeAt = undefined
        this.publish(paneKey)
        this.pump(paneKey, false)
      },
      Math.max(0, wakeAt - Date.now())
    )
    pane.wake.unref?.()
  }

  private publish(paneKey: string): void {
    const pane = this.panes.get(paneKey)
    const current = this.host.state.lastStatusByPaneKey.get(paneKey)
    if (!pane || !this.host.listening() || current?.payload.agentType !== 'codex') {
      return
    }
    const restated = codexRolloutStatus(this.host.state, current, pane.body, this.host.env())
    const update = restated && transcriptPollUpdate('codex', current, restated)
    if (update) {
      this.host.publish(update, pane)
    }
    this.armWake(paneKey)
  }
}
