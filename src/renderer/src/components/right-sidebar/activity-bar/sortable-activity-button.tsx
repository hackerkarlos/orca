import React from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ActivityBarButton, type ActivityBarItem } from './activity-bar-buttons'

export function SortableActivityButton({
  item,
  active,
  onClick,
  statusIndicator,
  layout
}: {
  layout: 'top' | 'side'
  item: ActivityBarItem
  active: boolean
  onClick: () => void
  statusIndicator?: 'success' | 'failure' | 'pending' | 'neutral' | 'cancelled' | null
}): React.JSX.Element {
  const { setNodeRef, setActivatorNodeRef, listeners, transform, transition } = useSortable({
    id: item.id
  })
  return (
    <ActivityBarButton
      item={item}
      active={active}
      onClick={onClick}
      layout={layout}
      statusIndicator={statusIndicator}
      buttonProps={{
        ...listeners,
        ref: (node) => {
          setNodeRef(node)
          setActivatorNodeRef(node)
        },
        style: { transform: CSS.Transform.toString(transform), transition }
      }}
    />
  )
}
