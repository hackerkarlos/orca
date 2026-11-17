import { normalizeHookPayload } from '../../normalization/normalize-hook-payload'
import type { AgentHookEventPayload } from '../../listener-event'
import type { HookListenerState } from '../../listener-state'
import { record } from './codex-rollout-jsonl-cursor'
import { buildCodexChildDrivenStatusPayload } from './codex-events'
import { markCodexLeadTurnInterrupted, setCodexMainAgentTurnState } from './codex-state'
import { pendingCodexAsyncQuestion } from './codex-async-questions'
import { codexCancelNeedsRollout } from './codex-interrupt-hook-support'
import {
  codexRolloutFile,
  codexRolloutReviewer,
  codexTranscriptTurnEnd,
  type CodexApprovalHold,
  type CodexRolloutState
} from './codex-rollout-state'

/** Past this a held approval shows with the last known reviewer, so a hung read cannot hide a prompt. */
const CODEX_APPROVAL_HOLD_MAX_MS = 5_000

function holdSettled(rollout: CodexRolloutState, hold: CodexApprovalHold, now: number): boolean {
  const file = codexRolloutFile(rollout, hold.filePath)
  return !file || file.resolved >= hold.seq || now - hold.heldAt >= CODEX_APPROVAL_HOLD_MAX_MS
}

/** When the oldest open approval hold must give up on its read. */
export function codexApprovalHoldDeadline(
  state: HookListenerState,
  paneKey: string
): number | undefined {
  const holds = [
    state.codexRolloutByPaneKey.get(paneKey)?.rootApprovalHold,
    ...Array.from(
      state.codexSubagentRosterByPaneKey.get(paneKey)?.values() ?? [],
      (child) => child.approvalHold
    )
  ]
  let deadline: number | undefined
  for (const hold of holds) {
    if (hold) {
      const due = hold.heldAt + CODEX_APPROVAL_HOLD_MAX_MS
      deadline = deadline === undefined ? due : Math.min(deadline, due)
    }
  }
  return deadline
}

/** Settle approvals whose reviewer read finished or timed out. */
function settleCodexApprovalHolds(state: HookListenerState, paneKey: string, now: number): void {
  const rollout = state.codexRolloutByPaneKey.get(paneKey)
  if (!rollout) {
    return
  }
  const rootHold = rollout.rootApprovalHold
  const lead = state.codexLeadStateByPaneKey.get(paneKey)
  // Ordering rule: any later root hook replaces the lead record, so the approval was answered.
  if (rootHold && lead !== rootHold.lead) {
    rollout.rootApprovalHold = undefined
  } else if (rootHold && holdSettled(rollout, rootHold, now)) {
    rollout.rootApprovalHold = undefined
    const settled =
      codexRolloutReviewer(rollout, rootHold.filePath) !== 'auto_review' ||
      pendingCodexAsyncQuestion(state, paneKey)
        ? 'waiting'
        : 'working'
    if (settled !== lead?.state) {
      setCodexMainAgentTurnState(state, paneKey, { state: settled, model: rootHold.lead.model })
    }
  }
  for (const child of state.codexSubagentRosterByPaneKey.get(paneKey)?.values() ?? []) {
    const hold = child.approvalHold
    if (!hold) {
      continue
    }
    if (!holdSettled(rollout, hold, now)) {
      continue
    }
    child.approvalHold = undefined
    child.state =
      codexRolloutReviewer(rollout, hold.filePath) === 'auto_review' ? 'working' : 'waiting'
  }
}

/** The row rollout facts imply for the current hook row, without I/O: a replayed Stop for an
 *  ended turn (/review, failed turn), a pre-0.150 cancel, or a restatement of names/approvals. */
export function codexRolloutStatus(
  state: HookListenerState,
  original: AgentHookEventPayload,
  body: unknown,
  env: string,
  now = Date.now()
): AgentHookEventPayload | undefined {
  settleCodexApprovalHolds(state, original.paneKey, now)
  const rollout = state.codexRolloutByPaneKey.get(original.paneKey)
  const lead = state.codexLeadStateByPaneKey.get(original.paneKey)
  const rootTurn = rollout?.rootTurn
  const interrupted =
    rootTurn?.interrupted === true &&
    lead !== undefined &&
    lead.state !== 'done' &&
    // A turn_aborted for an earlier turn must not cancel the one the hooks opened since.
    (!rootTurn.turnId || !lead.turnId || rootTurn.turnId === lead.turnId) &&
    codexCancelNeedsRollout(rollout)
  const envelope = record(body)
  if (
    !interrupted &&
    envelope &&
    rollout?.root &&
    lead?.turnId &&
    lead.state !== 'done' &&
    codexTranscriptTurnEnd(rollout, lead.turnId)
  ) {
    const stop = {
      ...envelope,
      hook_event_name: undefined,
      hookEventName: undefined,
      payload: {
        hook_event_name: 'Stop',
        ...(lead.sessionId ? { session_id: lead.sessionId } : {}),
        turn_id: lead.turnId,
        transcript_path: rollout.root.cursor.filePath
      }
    }
    return normalizeHookPayload(state, 'codex', stop, env) ?? undefined
  }
  if (interrupted) {
    markCodexLeadTurnInterrupted(state, original.paneKey)
  }
  const payload = buildCodexChildDrivenStatusPayload(state, undefined, original.paneKey, {})
  // Why: only a replayed Stop may carry an event name; this row restates the last hook's.
  return payload ? { ...original, hookEventName: undefined, payload } : undefined
}
