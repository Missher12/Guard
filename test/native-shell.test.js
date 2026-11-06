import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import PwshLocal from '@deepseek-ai/dsh-pwsh-local'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import { incompatibleCommand, probeShell } from '../src/probe.js'
import { createHost } from './host.js'

const exec = promisify(execFile)

const win = process.platform === 'win32'
const shells = win ? [['powershell.exe', 5], ['pwsh.exe', 7]]
  : process.env.DSH_TEST_PWSH ? [[process.env.DSH_TEST_PWSH, 7]] : []
for (const [file, major] of shells) {
  test('native ' + path.basename(file) + ' probe and admitted DSH call', async t => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'dsh 中文 space '))
    t.after(() => rm(cwd, { recursive: true, force: true }))
    const timeoutMs = 30000
    const h = await createHost({ cwd, config: { probeTimeoutMs: timeoutMs }, async installShell(ctx) {
      await ctx.plugin(SubprocessLocal)
      await ctx.plugin(PwshLocal, { pwshPath: file })
      // The control runs before the guard's first probe. A cold CI runner can
      // consume its first startup budget; timeout recovery has its own test.
      const ps = await probeShell('pwsh', ctx.get('shell'), { cwd, timeoutMs })
      assert.equal(ps.major, major, JSON.stringify(ps))
    } })
    t.after(h.close)
    for (let i = 0; i < 3; i++) assert.ok((await h.step()).tools.some(tool => tool.name === 'pwsh'))
    const result = await h.call('pwsh', { command: "Write-Output 'guard-ok'", description: 'Check shell' })
    assert.equal(result.isError, false, JSON.stringify(result.content))
    assert.match(result.content[0].text, /guard-ok/)
    if (major === 5) assert.equal((await h.call('pwsh', { command: 'echo 1 && echo 2', description: 'Check chaining' })).isError, true)
  })
}
test('Bash dialect marker works in a real Bash process', async () => {
  const file = win ? path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe') : '/bin/bash'
  const shell = { resolve: spec => spec, async execute(spec) {
    return { async result() {
      const out = await exec(file, ['--noprofile', '--norc', '-c', spec.command],
        { cwd: spec.workdir, signal: spec.signal, timeout: spec.timeoutMs, windowsHide: true })
      return { exitCode: 0, stdout: { text: out.stdout } }
    } }
  } }
  assert.equal((await probeShell('bash', shell, { cwd: process.cwd() })).ready, true)
})

for (const [file] of shells.filter(() => win)) {
  test(file + ' discovery does not execute a module initializer or veto its exported command', async t => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'guard module '))
    t.after(() => rm(dir, { recursive: true, force: true }))
    const module = path.join(dir, 'GuardFixture')
    await mkdir(module)
    await writeFile(path.join(module, 'GuardFixture.psd1'), "@{ RootModule='GuardFixture.psm1'; ModuleVersion='1.0.0'; FunctionsToExport=@('jq') }")
    await writeFile(path.join(module, 'GuardFixture.psm1'), "$env:GUARD_IMPORTED='yes'\nfunction jq { 'explicit-ok' }\nExport-ModuleMember -Function jq")
    const env = { ...process.env, PSModulePath: dir + ';' + (process.env.PSModulePath ?? ''), GUARD_IMPORTED: '',
      PSModuleAnalysisCachePath: path.join(dir, 'cache') }
    const installed = (await exec(file, ['-NoProfile', '-Command', '(Get-Process -Id $PID).Path'], { windowsHide: true })).stdout.trim()
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') env[key] = path.dirname(installed) + ';' + path.join(env.SystemRoot, 'System32')
    const run = command => exec(installed, ['-NoProfile', '-NonInteractive', '-Command', command], { cwd: dir, env, windowsHide: true })
    let imported
    const shell = { resolve: request => request, async execute(spec) {
      const result = await run(spec.command + "; [Console]::Error.WriteLine('import=' + $env:GUARD_IMPORTED)")
      imported = result.stderr.includes('import=yes')
      return { result: async () => ({ exitCode: 0, stdout: { text: result.stdout } }) }
    } }
    const facts = await probeShell('pwsh', shell, { cwd: dir, timeoutMs: 10000 })
    assert.equal(imported, false, 'enumerating commands must not initialize a module')
    assert.equal(facts.ready, true)
    assert.equal(incompatibleCommand({ command: 'jq' }, facts), undefined)
    assert.match((await run('jq')).stdout, /explicit-ok/)
  })
}
