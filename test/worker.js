import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const python = process.env.DSH_TEST_PYTHON || (process.platform === 'darwin'
  ? '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/python/bin/python3' : 'python')
export const worker = process.env.DSH_GUARD_TEST_ROOT ? path.join(process.env.DSH_GUARD_TEST_ROOT, 'src/batch-worker.py')
  : fileURLToPath(new URL('../src/batch-worker.py', import.meta.url))
export async function runWorker(root, request, extra = {}) {
  const p = spawn(python, ['-B', worker], { stdio: ['pipe', 'pipe', 'pipe'] })
  let out = '', err = ''
  p.stdout.on('data', b => { out += b })
  p.stderr.on('data', b => { err += b })
  p.stdin.end(JSON.stringify({ root, session: 'test-session', family: 'files', request, ...extra }))
  const code = await new Promise((resolve, reject) => { p.on('close', resolve); p.on('error', reject) })
  assert.equal(code, 0, err || out)
  return JSON.parse(out)
}
export async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'guard batch 中文 '))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
