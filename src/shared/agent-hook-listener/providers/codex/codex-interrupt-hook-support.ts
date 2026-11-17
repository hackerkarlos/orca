import type { CodexRolloutState } from './codex-rollout-state'

// Codex 0.150 added the Interrupt hook; older Codex records a cancel only as rollout turn_aborted.
const FIRST_INTERRUPT_HOOK_VERSION = [0, 150] as const

// Set by app main from its hooks/list trust probe of the installed Codex; unknown elsewhere.
let installedCodexListsInterrupt: boolean | undefined

export function recordInstalledCodexInterruptHook(listed: boolean | undefined): void {
  installedCodexListsInterrupt = listed
}

function predatesInterruptHook(cliVersion: string): boolean | undefined {
  const match = /^(\d+)\.(\d+)\./.exec(cliVersion)
  if (!match) {
    return undefined
  }
  const [major, minor] = [Number(match[1]), Number(match[2])]
  const [firstMajor, firstMinor] = FIRST_INTERRUPT_HOOK_VERSION
  return major < firstMajor || (major === firstMajor && minor < firstMinor)
}

/** Whether a cancel must come from the rollout: the session's own version decides, else the installed Codex's hook list; unknown keeps the rollout check. */
export function codexCancelNeedsRollout(rollout: CodexRolloutState | undefined): boolean {
  const sessionPredates = rollout?.cliVersion
    ? predatesInterruptHook(rollout.cliVersion)
    : undefined
  return sessionPredates ?? installedCodexListsInterrupt !== true
}
