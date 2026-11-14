import { expect, it } from 'vitest'
import { getTopActivityBarLayout } from './activity-bar-overflow'

it('reserves the More button for a hidden active tab at the boundary', () => {
  const items = [{ id: 'explorer' as const }, { id: 'checks' as const }]
  const layout = getTopActivityBarLayout(items, 72, 'plugin:active', true)
  expect(layout.visibleItems.map((item) => item.id)).toEqual(['explorer'])
  expect(layout.overflowItems.map((item) => item.id)).toEqual(['checks'])
})
