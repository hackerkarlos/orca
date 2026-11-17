import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'

import { readJsonlCursorAsync, readJsonlFirstRecordAsync } from './codex-rollout-async-read'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('async Codex rollout reads', () => {
  it.skipIf(process.platform === 'win32')(
    'reject writer-less FIFOs and symlinks to them instead of pinning a threadpool worker',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'codex-rollout-fifo-'))
      directories.push(directory)
      const fifo = join(directory, 'pipe.jsonl')
      const link = join(directory, 'link.jsonl')
      const created = await runProcess({ program: 'mkfifo', args: [fifo], timeoutMs: 5000 })
      expect(created.code).toBe(0)
      symlinkSync(fifo, link)
      for (const path of [fifo, link, directory]) {
        await expect(readJsonlFirstRecordAsync(path)).resolves.toBeUndefined()
        await expect(
          readJsonlCursorAsync({ filePath: path, offset: 0, carry: '' })
        ).resolves.toBeUndefined()
      }
    }
  )
})
