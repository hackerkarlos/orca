import { describe, expect, it } from 'vitest'
import { arrangeActivityItems, mergeActivityOrder } from './activity-bar-arrangement'
import { getDefaultRightSidebarActivityItems } from './right-sidebar-default-activity-items'
import { getVisibleRightSidebarActivityItems } from './right-sidebar-activity-visibility'
import { translate } from '@/i18n/i18n'

describe('activity bar arrangement', () => {
  const items = [{ id: 'explorer' }, { id: 'checks' }, { id: 'plugin-a', pluginKey: 'plugin-a' }]
  it('uses default order and appends new panels after saved items', () => {
    expect(arrangeActivityItems(items, []).map((item) => item.id)).toEqual([
      'explorer',
      'checks',
      'plugin-a'
    ])
    expect(
      arrangeActivityItems(
        [...items, { id: 'plugin-b', pluginKey: 'plugin-b' }],
        ['checks', 'explorer', 'plugin-a']
      ).map((item) => item.id)
    ).toEqual(['checks', 'explorer', 'plugin-a', 'plugin-b'])
  })
  it('ignores removed and duplicate ids', () => {
    expect(
      arrangeActivityItems(items, ['removed', 'checks', 'checks']).map((item) => item.id)
    ).toEqual(['explorer', 'checks', 'plugin-a'])
  })
  it('retains unavailable slots across a reorder and restores them', () => {
    const saved = ['explorer', 'checks', 'plugin-a']
    const updated = mergeActivityOrder(saved, ['plugin-a', 'explorer'])
    expect(updated).toEqual(['plugin-a', 'checks', 'explorer'])
    expect(arrangeActivityItems(items, updated).map((item) => item.id)).toEqual([
      'plugin-a',
      'checks',
      'explorer'
    ])
  })
  it('inserts newly available built-ins before plugins', () => {
    const workspaceB = [
      { id: 'explorer' },
      { id: 'vault' },
      { id: 'checks' },
      { id: 'plugin-a', pluginKey: 'plugin-a' }
    ]
    expect(
      arrangeActivityItems(workspaceB, ['checks', 'explorer', 'plugin-a']).map((item) => item.id)
    ).toEqual(['checks', 'explorer', 'vault', 'plugin-a'])
  })
  it('inserts a newly available built-in before a plugin moved ahead of saved built-ins', () => {
    const items = [
      { id: 'explorer' },
      { id: 'vault' },
      { id: 'workspaces' },
      { id: 'plugin-a', pluginKey: 'plugin-a' }
    ]
    expect(
      arrangeActivityItems(items, ['plugin-a', 'explorer', 'vault']).map((item) => item.id)
    ).toEqual(['workspaces', 'plugin-a', 'explorer', 'vault'])
  })
  it('keeps a saved plugin between built-ins when inserting a later default slot', () => {
    const defaults = [
      { id: 'explorer' },
      { id: 'workspaces' },
      { id: 'vault' },
      { id: 'plugin-a', pluginKey: 'plugin-a' }
    ]
    expect(
      arrangeActivityItems(defaults, ['explorer', 'plugin-a', 'vault']).map((item) => item.id)
    ).toEqual(['explorer', 'plugin-a', 'workspaces', 'vault'])
  })
  it.each([
    [
      ['explorer', 'plugin:test/panel', 'vault'],
      ['explorer', 'workspaces', 'pr-checks', 'source-control', 'plugin:test/panel', 'vault']
    ],
    [
      ['plugin:test/panel', 'explorer', 'vault'],
      ['workspaces', 'pr-checks', 'source-control', 'plugin:test/panel', 'explorer', 'vault']
    ]
  ])('inserts folder tabs using the production default for saved %j', (saved, expected) => {
    const defaults = getDefaultRightSidebarActivityItems({
      t: translate,
      explorerShortcut: '',
      sourceControlShortcut: '',
      checksShortcut: '',
      portsShortcut: ''
    })
    const plugin = {
      id: 'plugin:test/panel' as const,
      pluginKey: 'test',
      icon: defaults[0].icon,
      title: 'Plugin',
      shortcut: ''
    }
    const folderItems = getVisibleRightSidebarActivityItems([...defaults, plugin], {
      isFolder: true,
      isFolderWorkspace: true,
      hasSshHost: false
    })
    expect(arrangeActivityItems(folderItems, saved).map((item) => item.id)).toEqual(expected)
  })
})
