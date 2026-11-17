import { constants } from 'node:fs'
import { open, stat, type FileHandle } from 'node:fs/promises'

import {
  consumeJsonlText,
  jsonlReadWindow,
  record,
  TRANSCRIPT_LINE_MAX_BYTES,
  type JsonlCursor,
  type JsonRecord
} from './codex-rollout-jsonl-cursor'

// Why: a nonblocking open keeps a FIFO from pinning a threadpool worker before the descriptor check.
const READ_FLAGS = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK)

export type JsonlCursorRead = { cursor: JsonlCursor & { filePath: string }; records: JsonRecord[] }

async function withRegularFile<T>(
  filePath: string,
  read: (handle: FileHandle) => Promise<T>
): Promise<T | undefined> {
  const handle = await open(filePath, READ_FLAGS)
  try {
    const stats = await handle.stat()
    return stats.isFile() ? await read(handle) : undefined
  } finally {
    await handle.close().catch(() => {})
  }
}

/** Off-thread incremental read; returns an advanced copy so a caller can drop a stale result. Undefined: unreadable or vanished. */
export async function readJsonlCursorAsync(
  cursor: Readonly<JsonlCursor> & { filePath: string },
  lineFilter?: (line: string) => boolean
): Promise<JsonlCursorRead | undefined> {
  const next = { ...cursor }
  try {
    // Why: stat first so an unchanged rollout costs no open, which on-access scanners can slow.
    const stats = await stat(next.filePath)
    if (!stats.isFile()) {
      return undefined
    }
    const window = jsonlReadWindow(next, stats.size)
    if (window.length === 0) {
      return { cursor: next, records: [] }
    }
    return await withRegularFile(next.filePath, async (handle) => {
      const buffer = Buffer.allocUnsafe(window.length)
      const { bytesRead } = await handle.read(buffer, 0, window.length, window.start)
      const text = buffer.toString('utf8', 0, bytesRead)
      return {
        cursor: next,
        records: consumeJsonlText(next, window.start, text, bytesRead, lineFilter)
      }
    })
  } catch {
    return undefined
  }
}

/** 'pending' while the file or its first line is unwritten; 'unreadable' on other I/O failures; undefined once the line is final. */
export async function readJsonlFirstRecordAsync(
  filePath: string
): Promise<JsonRecord | 'pending' | 'unreadable' | undefined> {
  try {
    return await withRegularFile(filePath, async (handle) => {
      const buffer = Buffer.allocUnsafe(TRANSCRIPT_LINE_MAX_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      const newline = buffer.subarray(0, bytesRead).indexOf(0x0a)
      if (newline === -1) {
        return bytesRead < buffer.length ? 'pending' : undefined
      }
      try {
        return record(JSON.parse(buffer.toString('utf8', 0, newline)))
      } catch {
        return undefined
      }
    })
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
      ? 'pending'
      : 'unreadable'
  }
}
