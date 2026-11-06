import assert from 'node:assert/strict'
import test from 'node:test'
import { createHost, fixtureLog } from './host.js'
import * as plugin from '../src/index.js'

test('a broken inherited shell is absent from the first real DSH prompt and cannot execute a stale call', async t => {
  const h = await createHost({ working: false })
  t.after(h.close)
  const prompt = await h.step()
  assert.deepEqual(prompt.tools.map(tool => tool.name), ['read'])
  assert.ok(!prompt.sections.some(section => section.name === 'tool:pwsh'))
  assert.ok((await h.call('pwsh', { command: 'ls', description: 'List' })).isError)
  assert.equal(h.counts.commands, 0)
  assert.equal((await h.call('read')).content[0].text, 'answer=42')
  await h.step()
  assert.equal(h.counts.probes, 1)
  await h.disable()
  assert.ok((await h.step()).tools.some(tool => tool.name === 'pwsh'))
})

test('healthy PowerShell stays callable, the wrong shell dialect and incompatible commands never launch', async t => {
  const h = await createHost({ bash: true })
  t.after(h.close)
  assert.deepEqual((await h.step()).tools.map(tool => tool.name).sort(), ['pwsh', 'read'])
  for (const cmd of ['sed -n 1p x', 'git status && git diff']) {
    assert.equal((await h.call('pwsh', { command: cmd, description: 'Check files' })).isError, true)
  }
  assert.equal(h.counts.commands, 0)
  const ok = await h.call('pwsh', { command: 'grep test file', description: 'Search files' })
  assert.equal(ok.isError, false)
  assert.equal(ok.value.stdout.text, fixtureLog)
  assert.match(ok.content[0].text, /79 more times/)
  assert.equal(h.counts.probes, 2)
})

test('exact deny names work for late registrations, existing sessions on load, and after unload', async t => {
  const h = await createHost({ guard: false })
  t.after(h.close)
  await h.enable({ denyTools: ['tool_x'] })
  const remove = h.register('tool_x')
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(!(await h.step()).tools.some(tool => tool.name === 'tool_x'))
  assert.equal((await h.call('tool_x')).isError, true)
  remove()
  h.register('tool_x')
  const second = await h.addAgent('b')
  assert.ok(!(await h.step(second)).tools.some(tool => tool.name === 'tool_x'))
  await h.disable()
  assert.ok((await h.step()).tools.some(tool => tool.name === 'tool_x'))
})

test('production entry does nothing on POSIX / WSL', { skip: process.platform === 'win32' }, () => {
  plugin.apply(new Proxy({}, { get() { throw Error('touched a host service') } }), {})
})

test('PTC keeps run_code while its generated SDK excludes the unavailable shell', async t => {
  const h = await createHost({ working: false })
  t.after(h.close)
  await h.usePtc()
  const prompt = await h.step()
  assert.deepEqual(prompt.tools.map(t => t.name), ['run_code'])
  const sdk = prompt.sections.find(s => s.name === 'tools:sdk').text
  assert.match(sdk, /\bread\b/)
  assert.doesNotMatch(sdk, /\bpwsh\b/)
})

test('an explicitly denied tool registered on the agent itself never executes', async t => {
  const h = await createHost({ config: { denyTools: ['local_broken'] } })
  t.after(h.close)
  h.register('local_broken', h.agent.ctx)
  assert.equal((await h.call('local_broken')).isError, true)
  assert.equal(h.counts.reads, 0)
})

test('Native and PTC omit agent-owned denied tools, even when shadowing an inherited tool', async t => {
  const h = await createHost({ config: { denyTools: ['only_local', 'shadowed'] } })
  t.after(h.close)
  h.register('shadowed')
  for (const name of ['only_local', 'shadowed', 'local_ok']) h.register(name, h.agent.ctx)
  const visible = (await h.step()).tools.map(tool => tool.name)
  assert.ok(visible.includes('local_ok'))
  for (const name of ['only_local', 'shadowed']) assert.ok(!visible.includes(name), name + ' leaked to the model')
  if (typeof h.ctx.tools.resolve === 'function') {
    const signal = new AbortController().signal
    const toolSet = await h.ctx.tools.resolve({ agent: h.agent, modelSelection: {}, signal })
    try {
      const context = { scope: h.agent, toolSet, signal }
      await h.ctx.systemPrompt.assemble(context)
      assert.equal(context.toolSet, toolSet, 'the caller retains its own original tool set')
    } finally { toolSet.dispose() }
  }
  await h.usePtc()
  const prompt = await h.step()
  assert.deepEqual(prompt.tools.map(tool => tool.name), ['run_code'])
  const sdk = prompt.sections.find(section => section.name === 'tools:sdk').text
  assert.match(sdk, /\blocal_ok\b/)
  assert.doesNotMatch(sdk, /\b(?:only_local|shadowed)\b/)
})

test('an active session rechecks a changed sandbox without inheriting another session’s result', async t => {
  const h = await createHost()
  t.after(h.close)
  const second = await h.addAgent('b')
  await Promise.all([h.step(), h.step(second)])
  assert.equal(h.counts.probes, 2)
  h.policy.mode = 'workspace-write'
  await Promise.all([h.step(), h.step()])
  assert.equal(h.counts.probes, 3)
  await h.step(second)
  assert.equal(h.counts.probes, 4)
})

test('a backend that breaks mid-session is re-probed and hidden before the next step; no user command is replayed', async t => {
  const h = await createHost()
  t.after(h.close)
  h.backend.working = false
  const args = { command: 'Get-Date', description: 'Read date' }
  assert.equal((await h.call('pwsh', args)).isError, true)
  assert.ok(!(await h.step()).tools.some(t => t.name === 'pwsh'))
  assert.equal((await h.call('pwsh', args)).isError, true)
  assert.deepEqual(h.counts, { probes: 2, commands: 1, reads: 0 })
})

test('ordinary command errors keep a working shell and incur no extra probe', async t => {
  const h = await createHost()
  t.after(h.close)
  h.backend.commandError = new Error('Access denied reading project.log')
  assert.equal((await h.call('pwsh', { command: 'Get-Content project.log', description: 'Read log' })).isError, true)
  assert.ok((await h.step()).tools.some(t => t.name === 'pwsh'))
  assert.equal(h.counts.probes, 1)
})

test('a newly broken executable path is masked in the very next assembled request', async t => {
  const h = await createHost()
  t.after(h.close)
  h.ctx.get('shell').pwshPath = 'another-pwsh.exe'
  h.backend.working = false
  const prompt = await h.step()
  assert.ok(!prompt.tools.some(tool => tool.name === 'pwsh'))
  assert.ok(!prompt.sections.some(section => section.name === 'tool:pwsh'))
  assert.equal(h.counts.commands, 0)
})

test('denyTools also removes only the matching dedicated prompt section', async t => {
  const h = await createHost({ config: { denyTools: ['custom_cli'] } })
  t.after(h.close)
  h.register('custom_cli')
  h.ctx.systemPrompt.section({ name: 'tool:custom_cli', text: 'Call custom_cli to do work.', order: 100 })
  h.ctx.systemPrompt.section({ name: 'tool:custom_cli_help', text: 'Unrelated guidance.', order: 200 })
  const prompt = await h.step()
  assert.ok(!prompt.sections.some(s => s.name === 'tool:custom_cli'))
  assert.ok(prompt.sections.some(s => s.name === 'tool:custom_cli_help'))
})

test('an unrelated isolated preset shell cannot disable the working shell used by the tool', async t => {
  const h = await createHost({ presetShell: { resolve() { throw Error('different, broken executor') } } })
  t.after(h.close)
  assert.ok((await h.step()).tools.some(t => t.name === 'pwsh'))
  const result = await h.call('pwsh', { command: 'Get-Date', description: 'Read date' })
  assert.equal(result.isError, false)
  assert.equal(h.counts.commands, 1)
})
