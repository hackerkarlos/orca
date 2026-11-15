import { Plug, Files, GitBranch, ListChecks, Workflow } from 'lucide-react'
import type { Translate } from '@/i18n/use-translate'
import { AgentSessionHistoryIcon } from './agent-session-history-icon'
import type { ActivityBarItem } from './activity-bar-buttons'

export function getDefaultRightSidebarActivityItems({
  t,
  explorerShortcut,
  sourceControlShortcut,
  checksShortcut,
  portsShortcut
}: {
  t: Translate
  explorerShortcut: string
  sourceControlShortcut: string
  checksShortcut: string
  portsShortcut: string
}): ActivityBarItem[] {
  return [
    {
      id: 'explorer',
      icon: Files,
      title: t('auto.components.right.sidebar.index.8bc2bbc3a0', 'Explorer'),
      shortcut: explorerShortcut === 'Unassigned' ? '' : explorerShortcut
    },
    {
      id: 'vault',
      icon: AgentSessionHistoryIcon,
      title: t('auto.components.right.sidebar.index.aiVaultSessionHistory', 'Agents'),
      shortcut: ''
    },
    {
      id: 'workspaces',
      icon: Workflow,
      title: t('auto.components.right.sidebar.index.folderWorkspaces', 'Attached worktrees'),
      shortcut: '',
      folderOnly: true
    },
    {
      id: 'pr-checks',
      icon: ListChecks,
      title: t('auto.components.right.sidebar.index.parentPrChecks', 'PR Checks'),
      shortcut: '',
      folderOnly: true
    },
    {
      id: 'source-control',
      icon: GitBranch,
      title: t('auto.components.right.sidebar.index.0314901467', 'Source Control'),
      shortcut: sourceControlShortcut === 'Unassigned' ? '' : sourceControlShortcut,
      gitOnly: true
    },
    {
      id: 'checks',
      icon: ListChecks,
      title: t('auto.components.right.sidebar.index.83a10e3c44', 'Checks'),
      shortcut: checksShortcut === 'Unassigned' ? '' : checksShortcut,
      gitOnly: true
    },
    {
      id: 'ports',
      icon: Plug,
      title: t('auto.components.right.sidebar.index.441733b630', 'Ports'),
      shortcut: portsShortcut === 'Unassigned' ? '' : portsShortcut,
      sshOnly: true
    }
  ]
}
