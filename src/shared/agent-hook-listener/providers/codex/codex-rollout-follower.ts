import type { AgentHookEventPayload } from '../../listener-event'
import type { HookListenerState } from '../../listener-state'
import { transcriptPollUpdate } from '../../transcript-poll-policy'
import { readJsonlCursorAsync, readJsonlFirstRecordAsync } from './codex-rollout-async-read'
import { codexApprovalHoldDeadline, codexRolloutStatus } from './codex-rollout-status'
import {
  commitCodexRolloutRead,
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
 * - a name read is dropped once its child's session is gone; a held approval yields to any later hook;
 * - results publish against the row current when they land, never the row that started them.
 */
export class CodexRolloutFollower {
  private readonly panes = new Map<string, PaneFollow>()

  constructor(private readonly host: CodexRolloutFollowerHost) {}

  /** After each stored Codex hook: start the reads it asked for. */
  observe(paneKey: string, context: CodexRolloutHookContext): void {
    this.panes.set(paneKey, { ...this.panes.get(paneKey), ...context })
    this.pump(paneKey, false)
  }

  /** A tail tick from the watch-driven scheduler while a root turn is open. */
  tail(paneKey: string): void {
    this.pump(paneKey, true)
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
    if (!this.panes.has(paneKey)) {
      return
    }
    const state = this.host.state
    const rollout = state.codexRolloutByPaneKey.get(paneKey)
    if (rollout?.root && (tail || rollout.root.wanted > rollout.root.resolved)) {
      this.readRollout(paneKey, rollout, rollout.root)
    }
    for (const file of rollout?.childFiles.values() ?? []) {
      if (file.wanted > file.resolved) {
        this.readRollout(paneKey, rollout!, file)
      }
    }
    const roster = state.codexSubagentRosterByPaneKey.get(paneKey)
    if (roster) {
      for (const { id, filePath } of takeCodexSubagentIdentityReads(roster, Date.now())) {
        this.readIdentity(paneKey, roster, id, filePath)
      }
    }
    this.armWake(paneKey)
  }

  private readRollout(paneKey: string, rollout: CodexRolloutState, file: CodexRolloutFile): void {
    if (file.reading) {
      file.readAgain = true
      return
    }
    file.reading = true
    const asRoot = rollout.root === file
    const epoch = rollout.epoch
    const satisfies = file.wanted
    void readJsonlCursorAsync(file.cursor, isCodexStatusTranscriptLine)
      .then((read) => {
        file.reading = false
        const attached =
          this.host.state.codexRolloutByPaneKey.get(paneKey) === rollout &&
          (asRoot ? rollout.root === file : rollout.childFiles.get(file.cursor.filePath) === file)
        const current = attached && (!asRoot || rollout.epoch === epoch)
        if (current) {
          commitCodexRolloutRead(rollout, file, read, satisfies)
        }
        if (attached && file.readAgain) {
          file.readAgain = false
          this.readRollout(paneKey, rollout, file)
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
    paneKey: string,
    roster: CodexSubagentRoster,
    id: string,
    filePath: string
  ): void {
    void readJsonlFirstRecordAsync(filePath)
      .then((head) => {
        // A replaced roster belongs to a new session; this child went with the old one.
        if (this.host.state.codexSubagentRosterByPaneKey.get(paneKey) !== roster) {
          return
        }
        if (applyCodexSubagentIdentityRead(roster, id, filePath, head, Date.now())) {
          this.publish(paneKey)
        } else {
          this.armWake(paneKey)
        }
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
