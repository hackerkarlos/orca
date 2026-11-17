import { closeSync, openSync, readSync, statSync, type Stats } from 'node:fs'

const TRANSCRIPT_READ_MAX_BYTES = 1024 * 1024
export const TRANSCRIPT_LINE_MAX_BYTES = 256 * 1024

export type JsonlCursor = {
  filePath?: string
  offset: number
  carry: string
}

export type JsonRecord = Record<string, unknown>

export function record(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null ? (value as JsonRecord) : undefined
}

/** Where a bounded read of a file grown to `size` starts; a backlog past the cap keeps only its tail. */
export function jsonlReadWindow(
  cursor: JsonlCursor,
  size: number
): { start: number; length: number } {
  if (size < cursor.offset) {
    cursor.offset = 0
    cursor.carry = ''
  }
  const length = Math.min(size - cursor.offset, TRANSCRIPT_READ_MAX_BYTES)
  return { start: size - cursor.offset > length ? size - length : cursor.offset, length }
}

/** Advance the cursor over text read at `start`; lineFilter rejects raw substrings before JSON.parse. */
export function consumeJsonlText(
  cursor: JsonlCursor,
  start: number,
  text: string,
  bytesRead: number,
  lineFilter?: (line: string) => boolean
): JsonRecord[] {
  const skippedPrefix = start !== cursor.offset
  const lines = `${skippedPrefix ? '' : cursor.carry}${text}`.split('\n')
  cursor.offset = start + bytesRead
  cursor.carry = lines.pop() ?? ''
  if (skippedPrefix) {
    lines.shift()
  }
  const records: JsonRecord[] = []
  for (const line of lines) {
    if (
      (lineFilter && !lineFilter(line)) ||
      Buffer.byteLength(line, 'utf8') > TRANSCRIPT_LINE_MAX_BYTES
    ) {
      continue
    }
    try {
      const parsed = record(JSON.parse(line) as unknown)
      if (parsed) {
        records.push(parsed)
      }
    } catch {
      // A malformed rollout line must not block later lifecycle events.
    }
  }
  return records
}

/** Undefined distinguishes unreadable/vanished files from no new lines; lineFilter rejects raw substrings before JSON.parse. */
export function readJsonlCursor(
  cursor: JsonlCursor,
  lineFilter?: (line: string) => boolean
): JsonRecord[] | undefined {
  if (!cursor.filePath) {
    return undefined
  }
  let stats: Stats
  try {
    stats = statSync(cursor.filePath)
  } catch {
    return undefined
  }
  if (!stats.isFile()) {
    return undefined
  }
  const { start, length } = jsonlReadWindow(cursor, stats.size)
  if (length === 0) {
    return []
  }
  const buffer = Buffer.allocUnsafe(length)
  let bytesRead = 0
  let fd: number | undefined
  try {
    fd = openSync(cursor.filePath, 'r')
    bytesRead = readSync(fd, buffer, 0, length, start)
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
    }
  }
  return consumeJsonlText(
    cursor,
    start,
    buffer.toString('utf8', 0, bytesRead),
    bytesRead,
    lineFilter
  )
}
