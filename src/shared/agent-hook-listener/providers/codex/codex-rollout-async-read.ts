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
// New rollout bytes between hooks are small; a larger backlog costs one more read.
const FIRST_READ_BYTES = 64 * 1024

export type JsonlCursorRead = { cursor: JsonlCursor & { filePath: string }; records: JsonRecord[] }

/** Each awaited step waits for a main-loop turn, so the size check and first read share one. Undefined: not a regular file. */
async function readOpened<T>(
  filePath: string,
  firstRead: { position: number; length: number },
  consume: (handle: FileHandle, size: number, first: Buffer, firstBytes: number) => Promise<T>
): Promise<T | undefined> {
  const handle = await open(filePath, READ_FLAGS)
  try {
    const first = Buffer.allocUnsafe(firstRead.length)
    const [stats, read] = await Promise.allSettled([
      handle.stat(),
      handle.read(first, 0, firstRead.length, firstRead.position)
    ])
    if (stats.status === 'rejected') {
      throw stats.reason
    }
    if (!stats.value.isFile()) {
      return undefined
    }
    if (read.status === 'rejected') {
      throw read.reason
    }
    return await consume(handle, stats.value.size, first, read.value.bytesRead)
  } finally {
    void handle.close().catch(() => {})
  }
}

/**
 * Off-thread incremental read; returns an advanced copy so a caller can drop a stale result.
 * `skipUnchanged` stats first so an unchanged rollout costs no open, which on-access scanners can slow.
 * Undefined: unreadable or vanished.
 */
export async function readJsonlCursorAsync(
  cursor: Readonly<JsonlCursor> & { filePath: string },
  lineFilter?: (line: string) => boolean,
  options: { skipUnchanged?: boolean } = {}
): Promise<JsonlCursorRead | undefined> {
  const next = { ...cursor }
  try {
    if (options.skipUnchanged) {
      const stats = await stat(next.filePath)
      if (!stats.isFile()) {
        return undefined
      }
      if (stats.size === next.offset) {
        return { cursor: next, records: [] }
      }
    }
    const from = next.offset
    return await readOpened(
      next.filePath,
      { position: from, length: FIRST_READ_BYTES },
      async (handle, size, first, firstBytes) => {
        const window = jsonlReadWindow(next, size)
        let buffer = first
        let bytesRead = Math.min(firstBytes, window.length)
        if (window.start !== from || window.length > FIRST_READ_BYTES) {
          buffer = Buffer.allocUnsafe(window.length)
          ;({ bytesRead } = await handle.read(buffer, 0, window.length, window.start))
        }
        const text = buffer.toString('utf8', 0, bytesRead)
        return {
          cursor: next,
          records: consumeJsonlText(next, window.start, text, bytesRead, lineFilter)
        }
      }
    )
  } catch {
    return undefined
  }
}

/** 'pending' while the file or its first line is unwritten; 'unreadable' on other I/O failures; undefined once the line is final. */
export async function readJsonlFirstRecordAsync(
  filePath: string
): Promise<JsonRecord | 'pending' | 'unreadable' | undefined> {
  try {
    return await readOpened(
      filePath,
      { position: 0, length: TRANSCRIPT_LINE_MAX_BYTES },
      async (_handle, _size, buffer, bytesRead) => {
        const newline = buffer.subarray(0, bytesRead).indexOf(0x0a)
        if (newline === -1) {
          return bytesRead < buffer.length ? 'pending' : undefined
        }
        try {
          return record(JSON.parse(buffer.toString('utf8', 0, newline)))
        } catch {
          return undefined
        }
      }
    )
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
      ? 'pending'
      : 'unreadable'
  }
}
