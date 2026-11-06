import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import LocalFs from '@deepseek-ai/dsh-fs-local'
import PwshLocal from '@deepseek-ai/dsh-pwsh-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import * as FileTools from '@deepseek-ai/dsh-tool-fs'
import { createHost } from './host.js'

// A success exit cannot distinguish these files. Verify the content returned
// by the unguarded executor, and count original commands at that same boundary.
for (const shell of ['powershell.exe', 'pwsh.exe']) {
  for (const override of [false, true]) {
    test(shell + ' uses the intended ' + (override ? 'per-call' : 'session') + ' directory or is refused',
      { skip: process.platform !== 'win32' }, async t => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'guard paths '))
        t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
        const intended = path.join(root, 'project[1]')
        const neighbor = path.join(root, 'project1')
        for (const [folder, value] of [[intended, 'EXPECTED'], [neighbor, 'NEIGHBOR']]) {
          await mkdir(folder)
          await writeFile(path.join(folder, 'stamp.txt'), value)
        }
        await writeFile(path.join(intended, '日志.txt'), '构建完成', 'utf8')
        const cwd = override ? root : intended
        let commands = 0
        const options = { cwd, async installShell(ctx) {
          await ctx.plugin(Subprocess)
          class Counted extends PwshLocal {
            execute(spec) {
              if (!spec.command.includes('DSHWIN1:')) commands++
              return super.execute(spec)
            }
          }
          await ctx.plugin(Counted, { pwshPath: shell })
        }, async installRead(ctx) {
          await ctx.plugin(LocalFs, { cwd })
          await ctx.plugin(FileTools, { read: true, readImage: false, write: false, edit: false, applyPatch: false })
        } }
        const args = { command: "Get-Content -LiteralPath 'stamp.txt' -Raw -ErrorAction Stop", description: 'Read marker',
          ...(override ? { workdir: 'project[1]' } : {}) }
        const baseline = await createHost({ ...options, guard: false })
        t.after(baseline.close)
        const first = await baseline.call('pwsh', args)
        assert.equal(first.isError, false, 'control must complete a real read')
        assert.equal(first.value.exitCode, 0)
        const content = first.value.stdout.text.trim()
        assert.ok(['EXPECTED', 'NEIGHBOR'].includes(content), 'control must identify which file it read')
        if (shell === 'pwsh.exe') assert.equal(content, 'EXPECTED')
        const correct = content === 'EXPECTED'
        assert.equal(commands, 1)
        const h = await createHost(options)
        t.after(h.close)
        const listed = (await h.step()).tools.some(tool => tool.name === 'pwsh')
        assert.equal(listed, override || correct, 'tool visibility must reflect the actual default directory')
        const checked = await h.call('pwsh', args)
        assert.equal(checked.isError, !correct, 'a wrong directory must never dispatch the body')
        assert.equal(commands, correct ? 2 : 1)
        if (correct) assert.equal(checked.value.stdout.text.trim(), 'EXPECTED')
        const fallback = await h.call('read', { file_path: path.join(intended, 'stamp.txt') })
        assert.equal(fallback.isError, false)
        assert.match(fallback.content[0].text, /EXPECTED/)
        const utf8 = await h.call('read', { file_path: path.join(intended, '日志.txt') })
        assert.match(utf8.content[0].text, /构建完成/)
        if (override) {
          assert.ok((await h.step()).tools.some(tool => tool.name === 'pwsh'))
          assert.equal((await h.call('pwsh', { command: "'ok'", description: 'Use the normal directory' })).isError, false)
          if (shell === 'pwsh.exe') {
            for (const workdir of [root + '\\project1\\..\\project[1]', intended.slice(path.parse(intended).root.length - 1)]) {
              const other = await h.call('pwsh', { ...args, workdir })
              assert.equal(other.isError, false, 'a healthy PowerShell should resolve ' + workdir)
              assert.equal(other.value.stdout.text.trim(), 'EXPECTED')
            }
          }
        }
      })
  }
}
