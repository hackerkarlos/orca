import { extname, isAbsolute } from 'node:path'

import { record, type JsonRecord } from './codex-rollout-jsonl-cursor'
import type { JsonlCursorRead } from './codex-rollout-async-read'
import { reconcileCodexTranscriptTurn, type CodexTranscriptTurn } from './codex-turn-transcript'
import { readApprovalsReviewer, type CodexApprovalsReviewer } from './codex-subagent-reviewer'
import type { CodexLeadTurnState } from '../../main-agent-turn-state'

const MAX_TRACKED_TURN_ENDS = 16
const MAX_CHILD_ROLLOUTS = 64

/** One rollout Orca reads; at most one read of it is in flight. */
export type CodexRolloutFile = {
  cursor: { filePath: string; offset: number; carry: string }
  reviewer?: CodexApprovalsReviewer
  /** Latest reviewer request; a read that started after it satisfies it. */
  wanted: number
  resolved: number
  reading: boolean
  readAgain: boolean
}

/** A PermissionRequest whose classification a reviewer read still has to confirm. */
export type CodexApprovalHold = { filePath: string; seq: number; heldAt: number }

export type CodexRolloutState = {
  /**
   * Ordering rule: bumped whenever the root turn moves on (prompt, Stop, Interrupt, new rollout).
   * A root read that started under an older epoch is dropped, cursor included, so a late read
   * can never undo a hook that already settled or restarted the turn.
   */
  epoch: number
  /** The rollout the latest root hook named; /review moves it to the review rollout. */
  root?: CodexRolloutFile
  rootTurn: CodexTranscriptTurn
  turnEnds: Map<string, 'completed' | 'failed'>
  /** `cli_version` from the root rollout's session_meta, when the read reached the first line. */
  cliVersion?: string
  /** Child rollouts, read only for approvals reviewer ownership. */
  childFiles: Map<string, CodexRolloutFile>
  rootApprovalHold?: CodexApprovalHold & { lead: CodexLeadTurnState }
  requestSeq: number
  /** The reviewer request this turn's UserPromptSubmit made. */
  turnReviewerRequest?: number
}

export function normalizedCodexRolloutPath(transcriptPath: string | undefined): string | undefined {
  const normalizedPath = transcriptPath?.trim()
  return normalizedPath && isAbsolute(normalizedPath) && extname(normalizedPath) === '.jsonl'
    ? normalizedPath
    : undefined
}

function createRolloutFile(filePath: string): CodexRolloutFile {
  return {
    cursor: { filePath, offset: 0, carry: '' },
    wanted: 0,
    resolved: 0,
    reading: false,
    readAgain: false
  }
}

export function createCodexRolloutState(): CodexRolloutState {
  return {
    epoch: 0,
    rootTurn: { interrupted: false },
    turnEnds: new Map(),
    childFiles: new Map(),
    requestSeq: 0
  }
}

/** Follow the rollout a root hook named; a different rollout is a different thread. */
export function followCodexRootRollout(
  rollout: CodexRolloutState,
  transcriptPath: string | undefined
): void {
  const filePath = normalizedCodexRolloutPath(transcriptPath)
  if (!filePath || rollout.root?.cursor.filePath === filePath) {
    return
  }
  rollout.epoch += 1
  rollout.root = createRolloutFile(filePath)
  rollout.rootTurn = { interrupted: false }
  rollout.turnEnds.clear()
  rollout.cliVersion = undefined
  rollout.rootApprovalHold = undefined
  rollout.turnReviewerRequest = undefined
}

/** Ask for a fresh reviewer read of a rollout; returns the request a later read must satisfy. */
export function requestCodexRolloutReviewer(rollout: CodexRolloutState, filePath: string): number {
  let file =
    rollout.root?.cursor.filePath === filePath ? rollout.root : rollout.childFiles.get(filePath)
  if (!file) {
    if (rollout.childFiles.size >= MAX_CHILD_ROLLOUTS) {
      const oldest = rollout.childFiles.keys().next().value
      if (typeof oldest === 'string') {
        rollout.childFiles.delete(oldest)
      }
    }
    file = createRolloutFile(filePath)
    rollout.childFiles.set(filePath, file)
  }
  rollout.requestSeq += 1
  file.wanted = rollout.requestSeq
  return file.wanted
}

export function codexRolloutFile(
  rollout: CodexRolloutState,
  filePath: string
): CodexRolloutFile | undefined {
  return rollout.root?.cursor.filePath === filePath
    ? rollout.root
    : rollout.childFiles.get(filePath)
}

function readTurnEnd(
  recordValue: JsonRecord
): { turnId: string; end: 'completed' | 'failed' } | undefined {
  if (recordValue.type !== 'event_msg') {
    return undefined
  }
  const payload = record(recordValue.payload)
  const turnId = typeof payload?.turn_id === 'string' ? payload.turn_id.trim() : ''
  if ((payload?.type !== 'task_complete' && payload?.type !== 'turn_complete') || !turnId) {
    return undefined
  }
  return { turnId, end: payload.error == null ? 'completed' : 'failed' }
}

function readCliVersion(recordValue: JsonRecord): string | undefined {
  const version = record(recordValue.payload)?.cli_version
  return recordValue.type === 'session_meta' && typeof version === 'string'
    ? version.trim() || undefined
    : undefined
}

/** Apply a finished read: `read` undefined means the rollout was unreadable. */
export function commitCodexRolloutRead(
  rollout: CodexRolloutState,
  file: CodexRolloutFile,
  read: JsonlCursorRead | undefined,
  satisfies: number
): void {
  file.resolved = Math.max(file.resolved, satisfies)
  if (!read) {
    // A stale reviewer must never turn an unreadable rollout into a hidden prompt.
    file.reviewer = undefined
    return
  }
  file.cursor = read.cursor
  file.reviewer = readApprovalsReviewer(read.records) ?? file.reviewer
  if (file !== rollout.root) {
    return
  }
  reconcileCodexTranscriptTurn(rollout.rootTurn, read.records)
  for (const recordValue of read.records) {
    rollout.cliVersion = readCliVersion(recordValue) ?? rollout.cliVersion
    const turnEnd = readTurnEnd(recordValue)
    if (!turnEnd) {
      continue
    }
    rollout.turnEnds.delete(turnEnd.turnId)
    rollout.turnEnds.set(turnEnd.turnId, turnEnd.end)
    const oldest = rollout.turnEnds.keys().next()
    if (rollout.turnEnds.size > MAX_TRACKED_TURN_ENDS && !oldest.done) {
      rollout.turnEnds.delete(oldest.value)
    }
  }
}

export function codexTranscriptTurnEnd(
  rollout: CodexRolloutState | undefined,
  turnId: string
): 'completed' | 'failed' | undefined {
  return rollout?.turnEnds.get(turnId)
}

/** The root turn's reviewer once a read made for this turn landed. Codex writes turn_context
 *  (and its settings) before the turn's UserPromptSubmit hook, so that read already holds it. */
export function codexTurnReviewer(
  rollout: CodexRolloutState,
  filePath: string
): CodexApprovalsReviewer | undefined {
  const root = rollout.root
  return root?.cursor.filePath === filePath &&
    rollout.turnReviewerRequest !== undefined &&
    root.resolved >= rollout.turnReviewerRequest
    ? root.reviewer
    : undefined
}

/** Who reviews approvals for a rollout, as of its latest finished read. */
export function codexRolloutReviewer(
  rollout: CodexRolloutState | undefined,
  filePath: string
): CodexApprovalsReviewer | undefined {
  return rollout ? codexRolloutFile(rollout, filePath)?.reviewer : undefined
}
