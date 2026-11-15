export function arrangeActivityItems<T extends { id: string; pluginKey?: string }>(
  items: T[],
  order: string[]
): T[] {
  const byId = new Map(items.map((item) => [item.id, item]))
  const result: T[] = []
  for (const id of order) {
    const item = byId.get(id)
    if (item) {
      result.push(item)
      byId.delete(id)
    }
  }
  let previousBuiltin: T | undefined
  for (const [defaultIndex, item] of items.entries()) {
    if (item.pluginKey) {
      continue
    }
    if (byId.has(item.id)) {
      const previousIndex = previousBuiltin ? result.indexOf(previousBuiltin) : -1
      const firstPlugin = result.findIndex((entry) => entry.pluginKey)
      const nextBuiltin = items
        .slice(defaultIndex + 1)
        .find((entry) => !entry.pluginKey && result.includes(entry))
      const nextIndex = nextBuiltin ? result.indexOf(nextBuiltin) : -1
      const index =
        firstPlugin !== -1 && firstPlugin < previousIndex
          ? firstPlugin
          : nextIndex > previousIndex
            ? nextIndex
            : previousIndex + 1
      result.splice(index, 0, item)
      byId.delete(item.id)
    }
    previousBuiltin = item
  }
  return [...result, ...byId.values()]
}

export function mergeActivityOrder(saved: string[], reordered: string[]): string[] {
  const available = new Set(reordered)
  const slots = [...new Set([...saved, ...reordered])]
  let index = 0
  return slots.map((id) => (available.has(id) ? reordered[index++] : id))
}
