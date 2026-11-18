import assert from 'node:assert/strict'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execute, openBatchFixture } from './batch-fixture.js'
import { python, workspace } from './worker.js'

const supported = ['win32', 'darwin'].includes(process.platform)
const pluginEntry = process.env.DSH_GUARD_TEST_ENTRY ? await import(pathToFileURL(process.env.DSH_GUARD_TEST_ENTRY).href) : await import('../src/index.js')
async function host(t, root, mode, config = {}) {
  const h = await openBatchFixture(root, { mode, config, pluginEntry })
  t.after(h.close)
  return h
}

test('registered batch tool executes through actual DSH workspace-write confinement and returns receipts', { skip: !supported }, async t => {
  const root = await workspace(t)
  await writeFile(path.join(root, 'a.txt'), 'hello')
  const h = await host(t, root, 'workspace-write')
  const result = await h.call('guard_file_batch', { action: 'run', operations: [{ kind: 'copy', source: 'a.txt', destination: 'b.txt' }] })
  assert.equal(result.isError, false, JSON.stringify(result.content))
  assert.equal(result.value.status, 'completed', JSON.stringify(result.value))
  assert.equal(await readFile(path.join(root, 'b.txt'), 'utf8'), 'hello')
  const status = await h.call('guard_file_batch', { action: 'status', id: result.value.id })
  assert.equal(status.value.counts.completed, 1)
  const outside = await h.call('guard_file_batch', { action: 'run', operations: [{ kind: 'copy', source: 'a.txt', destination: '../escape.txt' }] })
  assert.equal(outside.value.status, 'failed')
})

test('the registered shared replacement accepts explicit files and keeps the DSH write boundary', { skip: !supported }, async t => {
  const root = await workspace(t)
  const files = ['甲.txt', '乙.txt']
  for (const file of files) await writeFile(path.join(root, file), '\ufeffpending\r\n')
  const request = { action: 'run', files, edits: [{ oldText: 'pending', newText: 'complete', count: 1 }] }
  const blocked = await host(t, root, 'read-only')
  assert.equal((await blocked.call('guard_file_batch', request)).isError, true)
  assert.equal(await readFile(path.join(root, files[0]), 'utf8'), '\ufeffpending\r\n')
  const h = await host(t, root, 'workspace-write')
  const result = await h.call('guard_file_batch', request)
  assert.equal(result.isError, false, JSON.stringify(result.content))
  assert.equal(result.value.status, 'completed', JSON.stringify(result.value))
  for (const file of files) assert.equal(await readFile(path.join(root, file), 'utf8'), '\ufeffcomplete\r\n')
  assert.equal((await h.call('guard_file_batch', { action: 'resume', id: result.value.id })).value.counts.completed, 2)
})

test('Office tool resolves the host skill runtime and resumes conversion through the DSH pipeline', { skip: process.platform !== 'darwin' }, async t => {
  const root = await workspace(t)
  await execute(python, ['-B', fileURLToPath(new URL('./office-fixtures.py', import.meta.url)), root])
  const h = await host(t, root, 'workspace-write')
  const kit = { node: process.execPath, cli: '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar.unpacked/dsh/node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js' }
  h.ctx.tools.register({ name: 'skill', description: 'Configured Office skill runtime',
    parameters: { type: 'object', properties: { name: { type: 'string' } } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async () => ({ content: 'Installed engine\n' + JSON.stringify({ libreofficeKit: kit }) }),
  })
  const result = await h.call('guard_office_batch', { action: 'export_pdf', files: [{ path: 'letter.docx' }] })
  assert.equal(result.isError, false, JSON.stringify(result.content))
  assert.equal(result.value.status, 'completed', JSON.stringify(result.value))
  // A pending conversion after a previous interruption must reacquire its engine.
  const recordPath = path.join(root, '.dsh-guard', result.value.id + '.json')
  const record = JSON.parse(await readFile(recordPath, 'utf8'))
  record.items[0].status = 'pending'
  await writeFile(recordPath, JSON.stringify(record))
  const { rm } = await import('node:fs/promises')
  await rm(path.join(root, 'guard-output/letter.pdf'))
  const resumed = await h.call('guard_office_batch', { action: 'resume', id: result.value.id })
  assert.equal(resumed.isError, false, JSON.stringify(resumed.content))
  assert.equal(resumed.value.status, 'completed', JSON.stringify(resumed.value))
})

test('read-only policy and denied runtime tool stop writes before user files change', { skip: !supported }, async t => {
  for (const [mode, config] of [['read-only', {}], ['workspace-write', { denyTools: ['load_workspace_dependencies'] }]]) await t.test(mode + JSON.stringify(config), async t => {
    const root = await workspace(t)
    await writeFile(path.join(root, 'a.txt'), 'hello')
    const h = await host(t, root, mode, config)
    const result = await h.call('guard_file_batch', { action: 'run', operations: [{ kind: 'copy', source: 'a.txt', destination: 'b.txt' }] })
    assert.equal(result.isError, true)
    assert.deepEqual(await readdir(root), ['a.txt'])
  })
})

test('successful batch receipts retain ordered targets and canonical items with full details on demand', { skip: !supported }, async t => {
  const root = await workspace(t)
  await writeFile(path.join(root, 'source.txt'), 'unchanged')
  const h = await host(t, root, 'workspace-write')
  const operations = Array.from({ length: 20 }, (_, i) => ({ kind: 'copy', source: 'source.txt', destination: `out/item-${i}.txt` }))
  const result = await h.call('guard_file_batch', { action: 'run', operations })
  assert.equal(result.isError, false, JSON.stringify(result.content))
  assert.equal(result.value.status, 'completed')
  assert.equal(result.value.items.length, 20)
  const rendered = JSON.parse(result.content[0].text)
  assert.equal(rendered.items, undefined)
  assert.deepEqual(rendered.targets, result.value.items.map(item => item.target))
  assert.deepEqual(rendered.details, { action: 'status', id: result.value.id })
  assert.ok(result.content[0].text.length < JSON.stringify(result.value).length * 0.75)
  const details = await h.call('guard_file_batch', rendered.details)
  assert.deepEqual(JSON.parse(details.content[0].text).items, result.value.items)
  assert.equal(await readFile(path.join(root, 'out/item-19.txt'), 'utf8'), 'unchanged')
})
