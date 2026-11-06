import assert from 'node:assert/strict'
import test from 'node:test'
import { createHost, fixtureLog, pwshMarker } from './host.js'
import * as plugin from '../src/index.js'

test('unobserved utilities get a file-tool hint without blocking module-only commands', async t => {
  const h = await createHost({ probeResult: { exitCode: 0,
    stdout: { text: pwshMarker(process.cwd(), 7, '', 'open'), truncated: false } } })
  t.after(h.close)
  const prompt = (await h.step()).sections.find(s => s.name === 'tool:pwsh').text
  assert.match(prompt, /Prefer file tools/)
  assert.doesNotMatch(prompt, /Missing/)
  assert.equal((await h.call('pwsh', { command: 'jq . data.json', description: 'Invoke optional module' })).isError, false)
})

test('timeout recovers in one shared probe after cooldown, without replaying any command', async t => {
  let now = 0
  t.mock.method(performance, 'now', () => now)
  const h = await createHost({ probeResult: { exitCode: 1, timedOut: true, stdout: { text: '' } } })
  t.after(h.close)
  const visible = prompt => prompt.tools.some(tool => tool.name === 'pwsh')
  assert.equal(visible(await h.step()), false)
  h.backend.probeResult = undefined
  assert.equal(visible(await h.step()), false)
  assert.equal((await h.call('pwsh', { command: 'echo stale', description: 'Try stale tool name' })).isError, true)
  assert.deepEqual(h.counts, { probes: 1, commands: 0, reads: 0 })
  now += 6000
  await Promise.all([h.step(), h.step()])
  assert.equal(visible(await h.step()), true)
  assert.deepEqual(h.counts, { probes: 2, commands: 0, reads: 0 })
})

test('an explicit sandbox denial is not retried when the clock advances', async t => {
  let now = 0
  t.mock.method(performance, 'now', () => now)
  const h = await createHost({ probeResult: { exitCode: 1, timedOut: true, sandbox: { denied: true }, stdout: { text: '' } } })
  t.after(h.close)
  assert.ok(!(await h.step()).tools.some(tool => tool.name === 'pwsh'))
  h.backend.probeResult = undefined
  now += 120000
  assert.ok(!(await h.step()).tools.some(tool => tool.name === 'pwsh'))
  assert.equal(h.counts.probes, 1)
})

test('a binding changed by another pre-execution hook cannot use a previous attestation', async t => {
  const h = await createHost()
  t.after(h.close)
  h.ctx.on('tools/pre-execute', async (exec, next) => {
    const result = await next()
    if (exec.name === 'pwsh') h.ctx.get('shell').pwshPath = 'different-powershell.exe'
    return result
  })
  assert.equal((await h.call('pwsh', { command: 'Get-Date', description: 'Check current binding' })).isError, true)
  assert.equal(h.counts.commands, 0)
})

test('session directory recovery inside the stock pwsh body cannot dispatch an unchecked command', async t => {
  let directory = process.cwd()
  let recover = false
  const h = await createHost({ workingDirectory: {
    get: () => directory,
    ensure: async () => {
      if (recover) directory += '/recovered'
      return directory
    },
  } })
  t.after(h.close)
  const args = { command: 'Get-Date', description: 'Check directory recovery' }
  assert.equal((await h.call('pwsh', args)).isError, false)
  recover = true
  assert.equal((await h.call('pwsh', args)).isError, true)
  assert.equal(h.counts.commands, 1, 'the recovered directory must never see the second command')
})

test('alternating concurrent workdirs share their probes and keep other directories hard-denied', async t => {
  const h = await createHost()
  t.after(h.close)
  const call = workdir => h.call('pwsh', { workdir, command: 'Get-Date', description: 'Use requested directory' })
  const results = await Promise.all(['alpha', 'beta', 'alpha', 'beta', 'alpha', 'beta'].map(call))
  assert.ok(results.every(result => !result.isError))
  assert.equal(h.counts.probes, 3, 'one default and one per requested workdir')
  h.backend.probeResult = { exitCode: 1, sandbox: { denied: true }, stdout: { text: '' } }
  assert.equal((await call('denied')).isError, true)
  h.backend.probeResult = undefined
  assert.equal((await call('gamma')).isError, false)
  assert.equal((await call('denied')).isError, true)
  assert.equal(h.counts.probes, 5)
})

test('a burst of distinct workdirs runs at most two probes at once', async t => {
  const h = await createHost()
  t.after(h.close)
  let active = 0, peak = 0
  h.backend.probeResult = async spec => {
    peak = Math.max(peak, ++active)
    await new Promise(resolve => setImmediate(resolve))
    active--
    return { exitCode: 0, stdout: { text: pwshMarker(spec.workdir) } }
  }
  const calls = Array.from({ length: 8 }, (_, i) => h.call('pwsh', { workdir: 'dir' + i, command: 'Get-Date', description: 'Read date' }))
  assert.ok((await Promise.all(calls)).every(result => !result.isError))
  assert.equal(peak, 2)
})

test('a full negative cache still verifies a previously unseen healthy directory', async t => {
  let now = 0
  t.mock.method(performance, 'now', () => now)
  const h = await createHost()
  t.after(h.close)
  const call = workdir => h.call('pwsh', { workdir, command: 'Get-Date', description: 'Read date' })
  h.backend.probeResult = { exitCode: 1, sandbox: { denied: true }, stdout: { text: '' } }
  for (let i = 0; i < 32; i++) assert.equal((await call('unavailable-' + i)).isError, true)
  h.backend.probeResult = undefined
  assert.equal((await call('healthy')).isError, false)
  assert.equal(h.counts.commands, 1)
  assert.equal(h.counts.probes, 34)
  // Eviction forgets a verdict, never grants permission: the same sandbox
  // must attest an evicted target again before a user command can start.
  h.backend.probeResult = { exitCode: 1, sandbox: { denied: true }, stdout: { text: '' } }
  assert.equal((await call('unavailable-0')).isError, true)
  assert.equal((await call('unavailable-1')).isError, true)
  assert.equal((await call('another-new-path')).isError, true)
  assert.equal(h.counts.probes, 35)
  assert.equal(h.counts.commands, 1)
  now += 6000
  h.backend.probeResult = undefined
  assert.equal((await call('another-new-path')).isError, false)
})

test('a provider without the last-mile hook requires an absolute directory and still runs healthy calls', async t => {
  const h = await createHost({ shellEnv: { collect: () => ({}) } })
  t.after(h.close)
  const args = { command: 'Get-Date', description: 'Read date' }
  assert.equal((await h.call('pwsh', args)).isError, true)
  assert.equal((await h.call('pwsh', { ...args, workdir: process.cwd() })).isError, false)
  assert.equal(h.counts.commands, 1)
})

test('a third-party bash keeps its own result renderer', async t => {
  const h = await createHost()
  t.after(h.close)
  h.agent.ctx.tools.register({ name: 'bash', description: 'Vendor persistent terminal', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object', properties: { exitCode: { type: 'integer' } } },
      render: () => [{ type: 'text', text: fixtureLog }] }, execute: () => ({ exitCode: 0 }) })
  const result = await h.call('bash')
  assert.equal(result.isError, false)
  assert.equal(result.content[0].text, fixtureLog)
})

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
