import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import PwshLocal from '@deepseek-ai/dsh-pwsh-local'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import { probeShell } from '../src/probe.js'
import { createHost } from './host.js'

const exec = promisify(execFile)

const win = process.platform === 'win32'
const shells = win ? [['powershell.exe', 5], ['pwsh.exe', 7]]
  : process.env.DSH_TEST_PWSH ? [[process.env.DSH_TEST_PWSH, 7]] : []
for (const [file, major] of shells) {
  test('native ' + path.basename(file) + ' probe and admitted DSH call', async t => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'dsh 中文 [space] '))
    t.after(() => rm(cwd, { recursive: true, force: true }))
    const h = await createHost({ cwd, config: { probeTimeoutMs: 10000 }, async installShell(ctx) {
      await ctx.plugin(SubprocessLocal)
      await ctx.plugin(PwshLocal, { pwshPath: file })
    } })
    t.after(h.close)
    const ps = await probeShell('pwsh', h.ctx.get('shell'), { cwd, timeoutMs: 10000 })
    assert.equal(ps.major, major)
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
