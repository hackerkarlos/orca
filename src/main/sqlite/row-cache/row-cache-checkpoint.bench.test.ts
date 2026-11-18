// Lane benchmark (not committed): main-thread time per row-cache commit with the WAL checkpoint
// in the commit (base) vs on the checkpoint worker (head), while another process writes and fsyncs.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KeyedJsonRowCache } from './keyed-json-row-cache'
import { RowCacheWalCheckpoints, spawnRowCacheCheckpointWorker } from './row-cache-wal-checkpoints'

const COMMITS = Number(process.env.BENCH_COMMITS ?? 400)
const ROWS_PER_COMMIT = 40
const ROW_BYTES = 4096

function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  return {
    n: sorted.length,
    sumMs: Math.round(sorted.reduce((a, b) => a + b, 0)),
    p50: +at(0.5).toFixed(2),
    p99: +at(0.99).toFixed(2),
    max: +sorted.at(-1)!.toFixed(2),
    over50: sorted.filter((v) => v > 50).length,
    over10: sorted.filter((v) => v > 10).length
  }
}

async function run(mode: 'main' | 'worker', dir: string) {
  const path = join(dir, `${mode}.db`)
  const walCheckpoints =
    mode === 'worker'
      ? new RowCacheWalCheckpoints(spawnRowCacheCheckpointWorker)
      : new RowCacheWalCheckpoints(null)
  const cache = new KeyedJsonRowCache(path, { schemaVersion: 1, walCheckpoints })
  const payload = 'x'.repeat(ROW_BYTES)
  const samples: number[] = []
  for (let i = 0; i < COMMITS; i++) {
    const changes = new Map<string, string | null>()
    for (let r = 0; r < ROWS_PER_COMMIT; r++) {
      changes.set(`k${(i * ROWS_PER_COMMIT + r) % 2000}`, JSON.stringify(`${i}:${payload}`))
    }
    const t0 = performance.now()
    cache.patch(changes, () => [])
    samples.push(performance.now() - t0)
    // Commits are spaced like a busy store; lets the worker run between them.
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  cache.close()
  return stats(samples)
}

describe('row-cache checkpoint off the commit path', () => {
  it('measures main-thread commit time under disk load', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-ckpt-bench-'))
    // Disk pressure: a separate process rewrites and fsyncs a 256 MB file in a loop.
    const load = spawn(
      'sh',
      ['-c', `while :; do dd if=/dev/zero of=${dir}/load bs=1M count=256 conv=fsync status=none; done`],
      { stdio: 'ignore' }
    )
    try {
      const order = (process.env.BENCH_ORDER ?? 'main,worker,main,worker').split(',')
      const results: Record<string, unknown>[] = []
      for (const mode of order) {
        results.push({ mode, ...(await run(mode === 'main' ? 'main' : 'worker', dir)) })
      }
      console.log(`BENCH ${JSON.stringify(results)}`)
      expect(results.length).toBe(order.length)
    } finally {
      load.kill('SIGKILL')
      rmSync(dir, { recursive: true, force: true })
    }
  }, 600_000)
})
