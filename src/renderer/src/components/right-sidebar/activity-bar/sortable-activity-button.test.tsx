// @vitest-environment happy-dom
import { DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SortableActivityButton } from './sortable-activity-button'

afterEach(cleanup)

function PointerDnd({ children }: { children: React.ReactNode }): React.JSX.Element {
  const sensors = useSensors(useSensor(PointerSensor))
  return <DndContext sensors={sensors}>{children}</DndContext>
}

it.each(['top', 'side'] as const)(
  'uses one tab stop and activates with Enter and Space in %s',
  async (layout) => {
    const onClick = vi.fn()
    const user = userEvent.setup()
    render(
      <TooltipProvider>
        <PointerDnd>
          <SortableContext items={['explorer']}>
            <SortableActivityButton
              item={{ id: 'explorer', title: 'Explorer', icon: () => null, shortcut: '' }}
              layout={layout}
              active={false}
              onClick={onClick}
            />
          </SortableContext>
        </PointerDnd>
      </TooltipProvider>
    )
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Explorer' }))
    await user.keyboard('{Enter} ')
    expect(onClick).toHaveBeenCalledTimes(2)
    await user.tab()
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'Explorer' }))
  }
)
