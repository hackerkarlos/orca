// @vitest-environment happy-dom
import { DndContext } from '@dnd-kit/core'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { RightSidebarTopActivityBar } from './right-sidebar-top-activity-bar'
import type { ActivityBarItem } from './activity-bar-buttons'

const item: ActivityBarItem = { id: 'explorer', title: 'Explorer', icon: () => null, shortcut: '' }
afterEach(cleanup)

it.each(['ContextMenu', 'F10'])('opens the tab menu with %s', (key) => {
  render(
    <DndContext>
      <RightSidebarTopActivityBar
        hasDesktopWindowChrome={false}
        topActivityStripRef={vi.fn()}
        topActivityLayout={{ visibleItems: [item], overflowItems: [] }}
        effectiveTab="explorer"
        onSelectTab={vi.fn()}
        checksStatus={null}
        closeButton={null}
        activityBarPosition="top"
        onChangeActivityBarPosition={vi.fn()}
        arrangementItems={[item]}
      />
    </DndContext>
  )
  const button = screen.getByRole('button', { name: 'Explorer' })
  button.focus()
  fireEvent.keyDown(button, { key, shiftKey: key === 'F10' })
  expect(screen.getByRole('menuitem', { name: 'Reset tab order' })).toBeTruthy()
})

it('focuses the neighbouring tab after hiding with the keyboard', async () => {
  const plugin: ActivityBarItem = {
    id: 'plugin:test/panel',
    pluginKey: 'test',
    title: 'Plugin',
    icon: () => null,
    shortcut: ''
  }
  const items = [item, plugin]
  useAppStore.setState({ activityBarHidden: [], rightSidebarEffectiveTab: 'plugin:test/panel' })
  render(
    <DndContext>
      <RightSidebarTopActivityBar
        hasDesktopWindowChrome={false}
        topActivityStripRef={vi.fn()}
        topActivityLayout={{ visibleItems: items, overflowItems: [] }}
        effectiveTab="plugin:test/panel"
        onSelectTab={vi.fn()}
        checksStatus={null}
        closeButton={null}
        activityBarPosition="top"
        onChangeActivityBarPosition={vi.fn()}
        arrangementItems={items}
      />
    </DndContext>
  )
  const button = screen.getByRole('button', { name: 'Plugin' })
  button.focus()
  fireEvent.keyDown(button, { key: 'F10', shiftKey: true })
  fireEvent.click(screen.getByRole('menuitem', { name: 'Hide' }))
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Explorer' }))
  )
  useAppStore.setState({ activityBarHidden: [], rightSidebarEffectiveTab: null })
})
