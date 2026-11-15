import { useMemo } from 'react'
import { useAppStore } from '@/store/index'
import { useRepoById } from '@/store/repos/use-repository-catalog'
import { isFolderRepo } from '../../../../../shared/repository/repo-kind'
import { parseWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import { getVisibleRightSidebarActivityItems } from './right-sidebar-activity-visibility'
import { getPluginPanelActivityItems } from '../plugin-panels/plugin-panel-activity-items'
import {
  getPortsPanelOwnerKey,
  portsPanelHostForOwnerKey,
  portsPanelReachesSshHost
} from '../ports/ports-panel-host'
import {
  collectInstalledPluginTabKeys,
  usePluginPanels,
  usePluginPanelsStore,
  type PluginPanelsFetchStatus
} from '@/store/plugins/catalog/plugin-contribution-catalog'
import { useShortcutLabel } from '@/lib/keyboard/useShortcutLabel'
import { useTranslate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { getDefaultRightSidebarActivityItems } from './right-sidebar-default-activity-items'
import type { ActivityBarItem } from './activity-bar-buttons'

export type RightSidebarActivityItems = {
  visibleItems: ActivityBarItem[]
  activeFolderWorkspaceKey: string | null
  pluginSystemEnabled: boolean
  pluginFetchStatus: PluginPanelsFetchStatus
  installedPluginTabKeys: Set<string>
}

export function useRightSidebarActivityItems({
  rightSidebarOpen
}: {
  rightSidebarOpen: boolean
}): RightSidebarActivityItems {
  const t = useTranslate()
  const languageRevision = useUiLanguageRevision()
  const explorerShortcut = useShortcutLabel('sidebar.explorer.toggle')
  const sourceControlShortcut = useShortcutLabel('sidebar.sourceControl.toggle')
  const checksShortcut = useShortcutLabel('sidebar.checks.toggle')
  const portsShortcut = useShortcutLabel('sidebar.ports.toggle')
  const activeWorktreeId = useAppStore((s) => (rightSidebarOpen ? s.activeWorktreeId : null))
  // Hide Git-only tabs for folder workspaces.
  const activeWorktree = useAppStore((s) =>
    activeWorktreeId ? (s.getKnownWorktreeById(activeWorktreeId) ?? null) : null
  )
  const activeRepo = useRepoById(activeWorktree?.repoId ?? null)
  const activeWorkspaceScope = parseWorkspaceKey(activeWorktreeId ?? '')
  const isFolderWorkspace = activeWorkspaceScope?.type === 'folder'
  const isFolder = isFolderWorkspace || (activeRepo ? isFolderRepo(activeRepo) : false)
  // Why the owner: a managed server's workspace names its server, not an SSH connection.
  const hasSshHost = useAppStore((s) =>
    portsPanelReachesSshHost(
      portsPanelHostForOwnerKey(getPortsPanelOwnerKey(s, activeWorktreeId)),
      s.runtimeEnvironments
    )
  )
  const pluginSystemEnabled = useAppStore((s) => s.settings?.pluginSystemEnabled === true)
  const pluginPanels = usePluginPanels()
  const visiblePluginPanels = useMemo(
    () => (pluginSystemEnabled ? pluginPanels : []),
    [pluginPanels, pluginSystemEnabled]
  )
  const installedPlugins = usePluginPanelsStore((s) => s.plugins)
  const pluginFetchStatus = usePluginPanelsStore((s) => s.fetchStatus)
  const pluginPanelErrors = usePluginPanelsStore((s) => s.panelErrors)
  const installedPluginTabKeys = useMemo(
    () => collectInstalledPluginTabKeys(installedPlugins),
    [installedPlugins]
  )

  const activityItems = useMemo<ActivityBarItem[]>(
    () => [
      ...getDefaultRightSidebarActivityItems({
        t,
        explorerShortcut,
        sourceControlShortcut,
        checksShortcut,
        portsShortcut
      }),
      // Append plugin tabs to preserve built-in navigation positions.
      ...getPluginPanelActivityItems(visiblePluginPanels, pluginPanelErrors)
    ],
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- translate() reads the UI language implicitly.
    [
      checksShortcut,
      explorerShortcut,
      pluginPanelErrors,
      visiblePluginPanels,
      portsShortcut,
      sourceControlShortcut,
      languageRevision,
      t
    ]
  )

  const visibleItems = useMemo(
    () =>
      getVisibleRightSidebarActivityItems(activityItems, {
        isFolder,
        isFolderWorkspace,
        hasSshHost
      }),
    [activityItems, isFolder, isFolderWorkspace, hasSshHost]
  )

  const activeFolderWorkspaceKey = isFolderWorkspace ? (activeWorktreeId ?? null) : null

  return {
    visibleItems,
    activeFolderWorkspaceKey,
    pluginSystemEnabled,
    pluginFetchStatus,
    installedPluginTabKeys
  }
}
