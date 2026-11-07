import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import BashLocal from '@deepseek-ai/dsh-bash-local'
import BashSandbox from '@deepseek-ai/dsh-bash-sandbox'
import LocalFs from '@deepseek-ai/dsh-fs-local'
import SandboxLocal from '@deepseek-ai/dsh-sandbox-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import * as FileTools from '@deepseek-ai/dsh-tool-fs'
import { createHost } from './host.js'

const mac = process.platform === 'darwin'
const pluginEntry = process.env.DSH_GUARD_TEST_ENTRY
  ? await import(pathToFileURL(process.env.DSH_GUARD_TEST_ENTRY).href) : await import('../src/index.js')
const visible = assembly => assembly.tools.map(tool => tool.name).filter(name => !name.startsWith('guard_'))
const body = result => result.content.map(block => block.text ?? '').join('\n')
const log = '正在构建 build step\n'.repeat(80) + 'BUILD OK\n'

async function workspace(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "dsh Mac 中文 [1] ' "))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  await writeFile(path.join(cwd, '答案 [1].txt'), 'answer=42\n')
  await writeFile(path.join(cwd, 'build.log'), log)
  return cwd
}

async function host(t, cwd, { mode, shellPath, guard = true, config = {} } = {}) {
  const counts = { probes: 0, commands: 0 }
  const Base = mode ? BashSandbox : BashLocal
  class CountedShell extends Base {
    execute(spec) {
      counts[/DSH(?:WIN|MAC)1:/.test(spec.command) ? 'probes' : 'commands']++
      return shellPath ? super.executeArgv(spec, [shellPath, '-c', spec.command]) : super.execute(spec)
    }
  }
  const h = await createHost({ cwd, bash: true, guard, config, nativeEntry: true, pluginEntry, sandboxMode: mode,
    async installShell(ctx) {
      await ctx.plugin(Subprocess)
      if (mode) await ctx.plugin(SandboxLocal)
      await ctx.plugin(CountedShell)
    },
    async installRead(ctx) {
      await ctx.plugin(LocalFs, { cwd })
      await ctx.plugin(FileTools, { read: true, readImage: false, write: false, edit: false, applyPatch: false })
    },
  })
  t.after(h.close)
  return { ...h, nativeCounts: counts }
}

test('macOS plugin entry keeps real Bash, removes mismatched PowerShell, and preserves Unicode files', { skip: !mac }, async t => {
  const h = await host(t, await workspace(t))
  const prompt = await h.step()
  assert.deepEqual(visible(prompt).sort(), ['bash', 'read'])
  const hint = prompt.sections.find(section => section.name === 'tool:bash').text
  assert.match(hint, /macOS.*Bash \d+\.\d+/)
  assert.match(hint, /command -v/)
  const result = await h.call('bash', { command: "cat '答案 [1].txt'", description: 'Read UTF-8 file' })
  assert.equal(result.isError, false, body(result))
  assert.equal(result.value.stdout.text, 'answer=42\n')
  await h.step()
  assert.deepEqual(h.nativeCounts, { probes: 2, commands: 1 }, 'cache both shell dialect checks')
  assert.equal((await h.call('pwsh', { command: 'Get-Date', description: 'Stale call' })).isError, true)
  assert.equal(h.nativeCounts.commands, 1)
})

test('macOS folds model-facing repeated output and preserves raw output and failed diagnostics', { skip: !mac }, async t => {
  const h = await host(t, await workspace(t))
  const result = await h.call('bash', { command: 'cat build.log', description: 'Read build log' })
  assert.equal(result.isError, false, body(result))
  assert.equal(result.value.stdout.text, log)
  assert.match(body(result), /79 more times/)
  assert.match(body(result), /BUILD OK/)
  const failed = await h.call('bash', { command: 'cat build.log; exit 2', description: 'Read failed build' })
  assert.equal(failed.value.exitCode, 2)
  assert.ok(body(failed).startsWith(log))
  assert.match(body(failed), /\[exit code: 2\]/)
})

test('macOS unavailable or wrong-dialect executors cannot run stale commands; file tools remain usable', { skip: !mac }, async t => {
  const cwd = await workspace(t)
  for (const shellPath of [path.join(cwd, 'missing-bash'), '/bin/zsh']) await t.test(path.basename(shellPath), async t => {
    const h = await host(t, cwd, { shellPath })
    assert.deepEqual(visible(await h.step()), ['read'])
    const refused = await h.call('bash', { command: 'printf unsafe', description: 'Stale shell call' })
    assert.equal(refused.isError, true)
    assert.equal(h.nativeCounts.commands, 0)
    const result = await h.call('read', { file_path: '答案 [1].txt' })
    assert.equal(result.isError, false, body(result))
    assert.match(body(result), /answer=42/)
    await h.usePtc()
    const sdk = (await h.step()).sections.find(section => section.name === 'tools:sdk').text
    assert.doesNotMatch(sdk, /\b(?:bash|pwsh)\(/)
  })
})

test('macOS exact denyTools applies to agent-owned tools and disappears on unload', { skip: !mac }, async t => {
  const h = await host(t, await workspace(t), { config: { denyTools: ['custom_cli'] } })
  h.register('custom_cli', h.agent.ctx)
  assert.ok(!visible(await h.step()).includes('custom_cli'))
  assert.equal((await h.call('custom_cli')).isError, true)
  assert.equal(h.counts.reads, 0)
  await h.disable()
  assert.ok(visible(await h.step()).includes('custom_cli'))
  assert.equal((await h.call('custom_cli')).isError, false)
})

test('macOS visibility agrees with the actual local and sandboxed DSH executors', { skip: !mac }, async t => {
  const cwd = await workspace(t)
  for (const mode of [undefined, 'read-only', 'workspace-write']) await t.test(mode ?? 'local', async t => {
    const command = { command: "printf 'DSH-CONTROL-OK'", description: 'Check actual executor' }
    const control = await host(t, cwd, { mode, guard: false })
    const baseline = await control.call('bash', command)
    const available = !baseline.isError && baseline.value?.exitCode === 0 &&
      baseline.value.sandbox?.mode === mode && !baseline.value.sandbox?.denied &&
      baseline.value.stdout.text === 'DSH-CONTROL-OK'
    const h = await host(t, cwd, { mode })
    assert.equal(visible(await h.step()).includes('bash'), available, body(baseline))
    const result = await h.call('bash', command)
    assert.equal(result.isError, !available, body(result))
    assert.equal(h.nativeCounts.commands, available ? 1 : 0)
    if (available) {
      assert.equal(result.value.stdout.text, 'DSH-CONTROL-OK')
      assert.equal(result.value.sandbox?.mode, mode)
    }
    const file = await h.call('read', { file_path: '答案 [1].txt' })
    assert.equal(file.isError, false, body(file))
    assert.match(body(file), /answer=42/)
    t.diagnostic(available ? '实际执行成功' : '本机执行器不可用；守卫已屏蔽，文件工具可用')
  })
})
