// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { TopActivityOverflowMenu, type ActivityBarItem } from './activity-bar-buttons'

const items: ActivityBarItem[] = [
  { id: 'explorer', title: 'Explorer', icon: () => null, shortcut: '' },
  { id: 'plugin:test:panel', pluginKey: 'test', title: 'Plugin', icon: () => null, shortcut: '' }
]

afterEach(() => {
  cleanup()
  useAppStore.setState({ activityBarOrder: [], activityBarHidden: [] })
})

it('hides and restores an overflowed panel through its context menu', () => {
  render(
    <TopActivityOverflowMenu
      items={[items[1]]}
      arrangementItems={items}
      activeTab="explorer"
      onSelect={vi.fn()}
      activityBarPosition="top"
      onChangeActivityBarPosition={vi.fn()}
    />
  )
  fireEvent.pointerDown(screen.getByRole('button', { name: 'More sidebar tabs' }), {
    button: 0,
    pointerType: 'mouse',
    ctrlKey: false
  })
  fireEvent.contextMenu(screen.getByRole('menuitem', { name: 'Plugin' }), {
    clientX: 40,
    clientY: 20
  })
  fireEvent.click(screen.getByRole('menuitem', { name: 'Hide' }))
  expect(useAppStore.getState().activityBarHidden).toEqual(['plugin:test:panel'])
  fireEvent.contextMenu(screen.getByRole('menuitem', { name: 'Plugin' }), {
    clientX: 40,
    clientY: 20
  })
  fireEvent.click(screen.getByRole('menuitem', { name: 'Show Plugin' }))
  expect(useAppStore.getState().activityBarHidden).toEqual([])
})

it('moves past hidden tabs and resets the arrangement', () => {
  const tabs: ActivityBarItem[] = [
    items[0],
    items[1],
    { id: 'checks', title: 'Checks', icon: () => null, shortcut: '' }
  ]
  useAppStore.setState({
    activityBarOrder: ['explorer', 'plugin:test:panel', 'checks'],
    activityBarHidden: ['plugin:test:panel']
  })
  render(
    <TopActivityOverflowMenu
      items={[tabs[2]]}
      arrangementItems={tabs}
      activeTab="explorer"
      onSelect={vi.fn()}
      activityBarPosition="top"
      onChangeActivityBarPosition={vi.fn()}
    />
  )
  fireEvent.pointerDown(screen.getByRole('button', { name: 'More sidebar tabs' }), {
    button: 0,
    pointerType: 'mouse',
    ctrlKey: false
  })
  fireEvent.contextMenu(screen.getByRole('menuitem', { name: 'Checks' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Move left' }))
  expect(useAppStore.getState().activityBarOrder).toEqual([
    'checks',
    'plugin:test:panel',
    'explorer'
  ])
  fireEvent.contextMenu(screen.getByRole('menuitem', { name: 'Checks' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Reset tab order' }))
  expect(useAppStore.getState().activityBarOrder).toEqual([])
  expect(useAppStore.getState().activityBarHidden).toEqual([])
})

it('opens the neighbouring panel when hiding the active panel', () => {
  useAppStore.setState({
    rightSidebarEffectiveTab: 'plugin:test:panel',
    rightSidebarTab: 'plugin:test:panel'
  })
  render(
    <TopActivityOverflowMenu
      items={[items[1]]}
      arrangementItems={items}
      activeTab="plugin:test:panel"
      onSelect={vi.fn()}
      activityBarPosition="top"
      onChangeActivityBarPosition={vi.fn()}
    />
  )
  fireEvent.pointerDown(screen.getByRole('button', { name: 'More sidebar tabs' }), {
    button: 0,
    pointerType: 'mouse',
    ctrlKey: false
  })
  fireEvent.contextMenu(screen.getByRole('menuitem', { name: 'Plugin' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Hide' }))
  expect(useAppStore.getState().rightSidebarTab).toBe('explorer')
})

it.each(['ContextMenu', 'F10'])('opens the overflow context menu with %s', (key) => {
  render(
    <TopActivityOverflowMenu
      items={[items[1]]}
      arrangementItems={items}
      activeTab="explorer"
      onSelect={vi.fn()}
      activityBarPosition="top"
      onChangeActivityBarPosition={vi.fn()}
    />
  )
  fireEvent.pointerDown(screen.getByRole('button', { name: 'More sidebar tabs' }), {
    button: 0,
    pointerType: 'mouse',
    ctrlKey: false
  })
  const item = screen.getByRole('menuitem', { name: 'Plugin' })
  item.focus()
  fireEvent.keyDown(item, { key, shiftKey: key === 'F10' })
  expect(screen.getByRole('menuitem', { name: 'Hide' })).toBeTruthy()
})

it('focuses the neighbouring overflow item after hiding from the menu', async () => {
  const first: ActivityBarItem = {
    id: 'plugin:test:first',
    pluginKey: 'test',
    title: 'First',
    icon: () => null,
    shortcut: ''
  }
  const second: ActivityBarItem = {
    id: 'plugin:test:second',
    pluginKey: 'test',
    title: 'Second',
    icon: () => null,
    shortcut: ''
  }
  const all = [first, second]
  function Overflow() {
    const hidden = useAppStore((s) => s.activityBarHidden)
    return (
      <TopActivityOverflowMenu
        items={all.filter((item) => !hidden.includes(item.id))}
        arrangementItems={all}
        activeTab="explorer"
        onSelect={vi.fn()}
        activityBarPosition="top"
        onChangeActivityBarPosition={vi.fn()}
      />
    )
  }
  render(<Overflow />)
  fireEvent.pointerDown(screen.getByRole('button', { name: 'More sidebar tabs' }), {
    button: 0,
    pointerType: 'mouse',
    ctrlKey: false
  })
  const firstItem = screen.getByRole('menuitem', { name: 'First' })
  firstItem.focus()
  fireEvent.keyDown(firstItem, { key: 'F10', shiftKey: true })
  fireEvent.click(screen.getByRole('menuitem', { name: 'Hide' }))
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Second' }))
  )
})
