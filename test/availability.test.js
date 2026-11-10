import assert from 'node:assert/strict'
import test from 'node:test'
import { createHost } from './host.js'
import { mountBatchTools } from '../src/batch.js'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'

const visible = (prompt, name) => prompt.tools.some(tool => tool.name === name)
const text = result => result.content.map(block => block.text ?? '').join('\n')
async function batches(h) {
  await h.ctx.plugin(Subprocess)
  await h.ctx.plugin({ name: 'test-batches', inject: ['tools'], apply: mountBatchTools })
  assert.ok(h.ctx.tools.get('guard_file_batch'), 'exercise registered batch tools before agent filtering')
}

async function disconnectedHost(t, options = {}) {
  let calls = 0, message = 'Not connected'
  const definition = () => ({ name: 'mcp__files__lookup', description: 'Look up remote files',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { calls++; if (message) throw Error(message); return 'found' },
  })
  let scope, remove
  const h = await createHost({ ...options, installRead(ctx) { scope = ctx; remove = ctx.tools.register(definition()) } })
  t.after(h.close)
  h.register('read')
  return { ...h, calls: () => calls, error: value => { message = value },
    replace: () => { remove(); remove = scope.tools.register(definition()) } }
}

test('a disconnected MCP tool disappears before the next Native/PTC selection; errors remain errors', async t => {
  const h = await disconnectedHost(t)
  const failed = await h.call('mcp__files__lookup')
  assert.equal(failed.isError, true)
  assert.match(text(failed), /Not connected/)
  assert.equal(visible(await h.step(), 'mcp__files__lookup'), false)
  assert.equal(visible(await h.step(), 'read'), true)
  const stale = await h.call('mcp__files__lookup')
  assert.equal(stale.isError, true)
  assert.equal(h.calls(), 1, 'a stale call must not reach the disconnected transport again')
  await h.usePtc()
  assert.doesNotMatch((await h.step()).sections.find(s => s.name === 'tools:sdk').text, /mcp__files__lookup/)
})

test('connection cooldown backs off on demand and success recovers without any automatic replay', async t => {
  let now = 0
  t.mock.method(performance, 'now', () => now)
  const h = await disconnectedHost(t)
  await h.call('mcp__files__lookup')
  now = 29000
  assert.equal(visible(await h.step(), 'mcp__files__lookup'), false)
  now = 31000
  assert.equal(visible(await h.step(), 'mcp__files__lookup'), true)
  assert.equal(h.calls(), 1)
  await h.call('mcp__files__lookup')
  now = 62000
  assert.equal(visible(await h.step(), 'mcp__files__lookup'), false)
  now = 92000
  h.error(undefined)
  assert.equal(visible(await h.step(), 'mcp__files__lookup'), true)
  assert.equal((await h.call('mcp__files__lookup')).isError, false)
  assert.equal(h.calls(), 3)
  assert.equal(visible(await h.step(), 'mcp__files__lookup'), true)
})

test('a new connection registration and a different agent do not inherit a stale failure', async t => {
  const h = await disconnectedHost(t)
  await h.call('mcp__files__lookup')
  const other = await h.addAgent('other')
  assert.equal(visible(await h.step(other), 'mcp__files__lookup'), true)
  h.replace()
  h.error(undefined)
  assert.equal(visible(await h.step(), 'mcp__files__lookup'), true)
  assert.equal((await h.call('mcp__files__lookup')).isError, false)
})

test('ordinary MCP errors, cancellation and another plugin with similar prose never disable a tool', async t => {
  const h = await disconnectedHost(t)
  for (const message of ['File not found', 'Permission denied', 'Invalid arguments', 'Request timed out',
    'Document says: Not connected', 'Operation cancelled']) {
    h.error(message)
    assert.equal((await h.call('mcp__files__lookup')).isError, true)
    assert.equal(visible(await h.step(), 'mcp__files__lookup'), true, message)
  }
  h.agent.ctx.tools.register({ name: 'local_lookup', description: 'Local lookup', parameters: { type: 'object' },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { throw Error('Not connected') } })
  await h.call('local_lookup')
  assert.equal(visible(await h.step(), 'local_lookup'), true)
})

test('unloading the guard immediately restores cooled-down registrations', async t => {
  const h = await disconnectedHost(t)
  await h.call('mcp__files__lookup')
  assert.equal(visible(await h.step(), 'mcp__files__lookup'), false)
  await h.disable()
  assert.equal(visible(await h.step(), 'mcp__files__lookup'), true)
})

test('the MCP closed-connection diagnostic cools down only the failed binding and resets with the environment', async t => {
  const h = await disconnectedHost(t)
  h.error('MCP error -32000: Connection closed')
  await h.call('mcp__files__lookup')
  assert.equal(visible(await h.step(), 'mcp__files__lookup'), false)
  h.policy.mode = 'workspace-write'
  assert.equal(visible(await h.step(), 'mcp__files__lookup'), true)
  assert.equal(h.calls(), 1)
})

test('MCP cooldown invalidation does not depend on the shell preset being attestable', async t => {
  const h = await disconnectedHost(t, { presetShell: { resolve() {}, execute() {} } })
  await h.call('mcp__files__lookup')
  assert.equal(visible(await h.step(), 'mcp__files__lookup'), false)
  h.policy.mode = 'workspace-write'
  assert.equal(visible(await h.step(), 'mcp__files__lookup'), true)
})

test('a late failure from an old MCP registration cannot hide its recovered replacement', async t => {
  const h = await createHost()
  t.after(h.close)
  let reject, started
  const begun = new Promise(resolve => { started = resolve })
  const definition = execute => ({ name: 'mcp__service__read', description: 'Remote read', parameters: { type: 'object' },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute })
  const remove = h.agent.ctx.tools.register(definition(() => new Promise((_, fail) => { reject = fail; started() })))
  const call = h.call('mcp__service__read')
  await begun
  remove()
  h.agent.ctx.tools.register(definition(async () => 'reconnected'))
  reject(Error('Not connected'))
  assert.equal((await call).isError, true)
  assert.equal(visible(await h.step(), 'mcp__service__read'), true)
  assert.equal((await h.call('mcp__service__read')).isError, false)
})

test('a foreign tool shadowing the batch name keeps its own dependency contract', async t => {
  const h = await createHost()
  t.after(h.close)
  h.register('guard_file_batch', h.agent.ctx)
  assert.equal(visible(await h.step(), 'guard_file_batch'), true)
  assert.equal((await h.call('guard_file_batch')).isError, false)
})

test('batch tools without their runtime dependency are absent from declarations and recover on registration', async t => {
  const h = await createHost()
  t.after(h.close)
  await batches(h)
  assert.equal(visible(await h.step(), 'guard_file_batch'), false)
  assert.equal(visible(await h.step(), 'guard_office_batch'), false)
  assert.equal((await h.call('guard_file_batch')).isError, true)
  assert.equal(h.counts.reads, 0)
  h.register('load_workspace_dependencies')
  assert.equal(visible(await h.step(), 'guard_file_batch'), true)
  assert.equal(visible(await h.step(), 'guard_office_batch'), true)
})

test('a runtime excluded by the host activation condition also hides dependent batch schemas', async t => {
  const h = await createHost()
  t.after(h.close)
  if (typeof h.ctx.tools.resolve !== 'function') return t.skip('host activation conditions require DSH 0.2.2')
  let ready = false
  await batches(h)
  h.agent.ctx.tools.register({ name: 'load_workspace_dependencies', description: 'Conditional runtime',
    parameters: { type: 'object' }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'runtime' }, { when: () => ready })
  assert.equal(visible(await h.step(), 'guard_file_batch'), false)
  ready = true
  assert.equal(visible(await h.step(), 'guard_file_batch'), true)
})
