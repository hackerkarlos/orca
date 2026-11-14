// @vitest-environment happy-dom
import { DndContext } from '@dnd-kit/core'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
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
