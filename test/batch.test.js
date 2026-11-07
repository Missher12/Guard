import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { watch, readFileSync } from 'node:fs'
import { readFile, writeFile, readdir, rm, symlink, mkdir, chmod, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { python, worker, runWorker, workspace } from './worker.js'

test('batch copies, renames and replaces complete UTF-8 files, preserving BOM and CRLF', async t => {
  const root = await workspace(t)
  await writeFile(path.join(root, 'a.txt'), '\ufeffhello\r\n')
  await writeFile(path.join(root, 'b.txt'), 'keep')
  await writeFile(path.join(root, 'c.txt'), 'old old')
  const result = await runWorker(root, { action: 'run', operations: [
    { kind: 'copy', source: 'a.txt', destination: 'out/复制.txt' },
    { kind: 'rename', source: 'b.txt', destination: 'renamed.txt' },
    { kind: 'replace_text', source: 'c.txt', edits: [{ oldText: 'old', newText: 'new', count: 2 }] },
  ] })
  assert.equal(result.status, 'completed', JSON.stringify(result))
  assert.equal(result.counts.completed, 3)
  assert.equal(await readFile(path.join(root, 'out/复制.txt'), 'utf8'), '\ufeffhello\r\n')
  assert.equal(await readFile(path.join(root, 'renamed.txt'), 'utf8'), 'keep')
  assert.equal(await readFile(path.join(root, 'c.txt'), 'utf8'), 'new new')
  assert.ok(!(await readdir(root)).includes('b.txt'))
  const again = await runWorker(root, { action: 'resume', id: result.id })
  assert.equal(again.status, 'completed')
  assert.equal(await readFile(path.join(root, 'c.txt'), 'utf8'), 'new new')
})

test('collisions, dependent paths, binary text and match-count conflicts cannot partially alter a batch', async t => {
  const root = await workspace(t)
  await writeFile(path.join(root, 'a'), 'A')
  await writeFile(path.join(root, 'b'), 'B')
  for (const operations of [
    [{ kind: 'copy', source: 'a', destination: 'fresh' }, { kind: 'move', source: 'b', destination: 'a' }],
    [{ kind: 'rename', source: 'a', destination: 'c' }, { kind: 'rename', source: 'b', destination: 'c' }],
    [{ kind: 'replace_text', source: 'a', edits: [{ oldText: 'A', newText: 'X', count: 2 }] }],
    [{ kind: 'copy', source: 'a', destination: '../outside' }],
    [{ kind: 'copy', source: 'a', destination: 'fresh', edits: [{ oldText: 'A', newText: 'X', count: 1 }] }],
  ]) {
    const result = await runWorker(root, { action: 'run', operations })
    assert.equal(result.status, 'failed', JSON.stringify(result))
    assert.equal(await readFile(path.join(root, 'a'), 'utf8'), 'A')
    assert.equal(await readFile(path.join(root, 'b'), 'utf8'), 'B')
    assert.ok(!(await readdir(root)).includes('fresh'))
  }
  await writeFile(path.join(root, 'binary'), Buffer.from([0, 255, 1]))
  assert.equal((await runWorker(root, { action: 'run', operations: [
    { kind: 'replace_text', source: 'binary', edits: [{ oldText: 'A', newText: 'B', count: 1 }] },
  ] })).status, 'failed')
})

test('batch refuses symlink ancestors, cross-session resume and modified pending inputs', async t => {
  const root = await workspace(t)
  await writeFile(path.join(root, 'a'), 'A')
  if (process.platform !== 'win32') {
    await symlink(os.tmpdir(), path.join(root, 'escape'))
    assert.equal((await runWorker(root, { action: 'run', operations: [
      { kind: 'copy', source: 'a', destination: 'escape/a' },
    ] })).status, 'failed')
  }
  const done = await runWorker(root, { action: 'run', operations: [{ kind: 'copy', source: 'a', destination: 'b' }] })
  assert.equal((await runWorker(root, { action: 'resume', id: done.id }, { session: 'someone-else' })).status, 'failed')
  const file = path.join(root, '.dsh-guard', done.id + '.json')
  const receipt = JSON.parse(await readFile(file, 'utf8'))
  receipt.items[0].status = 'pending'
  await rm(path.join(root, 'b'))
  await writeFile(file, JSON.stringify(receipt))
  await writeFile(path.join(root, 'a'), 'changed')
  const resumed = await runWorker(root, { action: 'resume', id: done.id })
  assert.equal(resumed.status, 'partial')
  assert.equal(resumed.items[0].status, 'failed')
  assert.ok(!(await readdir(root)).includes('b'))
})

test('recovery verifies already-published outputs and never replays an uncertain effect', async t => {
  const root = await workspace(t)
  await writeFile(path.join(root, 'a'), 'A')
  const done = await runWorker(root, { action: 'run', operations: [{ kind: 'copy', source: 'a', destination: 'b' }] })
  const file = path.join(root, '.dsh-guard', done.id + '.json')
  const receipt = JSON.parse(await readFile(file, 'utf8'))
  receipt.items[0].status = 'uncertain'
  await writeFile(file, JSON.stringify(receipt))
  assert.equal((await runWorker(root, { action: 'resume', id: done.id })).status, 'completed')
  await writeFile(file, JSON.stringify(receipt))
  await writeFile(path.join(root, 'b'), 'external edit')
  const resumed = await runWorker(root, { action: 'resume', id: done.id })
  assert.equal(resumed.items[0].status, 'uncertain')
  assert.equal(await readFile(path.join(root, 'b'), 'utf8'), 'external edit')
})

test('list/status finds original receipts after lost responses and dependent source mutations are refused', async t => {
  const root = await workspace(t)
  await writeFile(path.join(root, 'a'), 'A')
  const unsafe = await runWorker(root, { action: 'run', operations: [
    { kind: 'move', source: 'a', destination: 'b' }, { kind: 'copy', source: 'a', destination: 'c' },
  ] })
  assert.equal(unsafe.status, 'failed')
  assert.equal(await readFile(path.join(root, 'a'), 'utf8'), 'A')
  const done = await runWorker(root, { action: 'run', operations: [{ kind: 'copy', source: 'a', destination: 'b' }] })
  assert.equal((await runWorker(root, { action: 'list' })).items[0].id, done.id)
  assert.equal((await runWorker(root, { action: 'status', id: done.id })).counts.completed, 1)
  assert.equal((await runWorker(root, { action: 'list' }, { session: 'other' })).items.length, 0)
})

test('explicit continue policy processes independent items after a runtime failure', { skip: process.platform === 'win32' }, async t => {
  const root = await workspace(t)
  const locked = path.join(root, 'locked')
  await mkdir(locked)
  t.after(() => chmod(locked, 0o755).catch(() => {}))
  await chmod(locked, 0o555)
  await writeFile(path.join(root, 'a'), 'A')
  const result = await runWorker(root, { action: 'run', onError: 'continue', operations: [
    { kind: 'copy', source: 'a', destination: 'locked/a' }, { kind: 'copy', source: 'a', destination: 'b' },
  ] })
  assert.equal(result.status, 'partial')
  assert.equal(result.items[0].status, 'failed')
  assert.equal(result.items[1].status, 'completed')
  assert.equal(await readFile(path.join(root, 'b'), 'utf8'), 'A')
})

test('a terminated real worker leaves whole files and resume never replays completed copies', { timeout: 30000 }, async t => {
  const root = await workspace(t)
  const content = Buffer.alloc(1024 * 1024, 0x61)
  await writeFile(path.join(root, 'a'), content)
  const store = path.join(root, '.dsh-guard')
  await mkdir(store)
  let child, interrupted
  const watcher = watch(store, (_event, name) => {
    if (!name?.endsWith('.json') || interrupted) return
    try {
      const receipt = JSON.parse(readFileSync(path.join(store, name), 'utf8'))
      if (receipt.items.some(row => row.status === 'completed') && receipt.items.some(row => row.status === 'pending')) {
        interrupted = receipt
        child.kill()
      }
    } catch { /* Atomic journal replacement can invalidate an earlier watch event. */ }
  })
  t.after(() => { watcher.close(); child?.kill() })
  child = spawn(python, ['-B', worker], { stdio: ['pipe', 'ignore', 'pipe'] })
  child.stdin.end(JSON.stringify({ root, session: 'test-session', family: 'files', request: { action: 'run',
    operations: Array.from({ length: 100 }, (_, i) => ({ kind: 'copy', source: 'a', destination: `out/${i}` })) } }))
  const code = await new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject) })
  watcher.close()
  assert.ok(interrupted, 'the worker was interrupted after at least one durable completion')
  assert.notEqual(code, 0)
  const completed = interrupted.items.find(row => row.status === 'completed').target
  const before = await stat(path.join(root, completed), { bigint: true })
  const resumed = await runWorker(root, { action: 'resume', id: interrupted.id })
  assert.ok(['completed', 'partial'].includes(resumed.status), JSON.stringify(resumed))
  const after = await stat(path.join(root, completed), { bigint: true })
  assert.equal(after.ino, before.ino)
  assert.equal(after.mtimeNs, before.mtimeNs)
  for (const name of await readdir(path.join(root, 'out'))) {
    if (/^\d+$/.test(name)) assert.deepEqual(await readFile(path.join(root, 'out', name)), content)
  }
  assert.deepEqual(await readFile(path.join(root, 'a')), content)
})
