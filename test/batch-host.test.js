import assert from 'node:assert/strict'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import BashSandbox from '@deepseek-ai/dsh-bash-sandbox'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import { createHost } from './host.js'
import { python, workspace } from './worker.js'

const supported = ['win32', 'darwin'].includes(process.platform)
const execute = promisify(execFile)
const pluginEntry = process.env.DSH_GUARD_TEST_ENTRY ? await import(pathToFileURL(process.env.DSH_GUARD_TEST_ENTRY).href) : await import('../src/index.js')
async function host(t, root, mode, config = {}) {
  const h = await createHost({ cwd: root, bash: true, nativeEntry: true, sandboxMode: mode, config, pluginEntry,
    async installShell(ctx) {
      await ctx.plugin(Subprocess)
      await ctx.plugin(Sandbox)
      await ctx.plugin(BashSandbox)
    },
  })
  t.after(h.close)
  const executable = (await execute(python, ['-c', 'import sys; print(sys.executable)'])).stdout.trim()
  h.ctx.tools.register({ name: 'load_workspace_dependencies', description: 'Test runtime path query',
    parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async () => ({ python: executable }),
  })
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
