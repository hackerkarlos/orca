import React from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ActivityBarButton, type ActivityBarItem } from './activity-bar-buttons'

export function SortableActivityButton({
  item,
  active,
  onClick,
  statusIndicator
}: {
  item: ActivityBarItem
  active: boolean
  onClick: () => void
  statusIndicator?: 'success' | 'failure' | 'pending' | 'neutral' | 'cancelled' | null
}): React.JSX.Element {
  const { setNodeRef, attributes, listeners, transform, transition } = useSortable({ id: item.id })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
    >
      <ActivityBarButton
        item={item}
        active={active}
        onClick={onClick}
        layout="side"
        statusIndicator={statusIndicator}
      />
    </div>
  )
}
