import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
            const driveRooted = intended.slice(path.parse(intended).root.length - 1)
            for (const workdir of [root + '\\project1\\..\\project[1]', driveRooted]) {
              const input = { ...args, workdir }
              const before = commands
              const control = await baseline.call('pwsh', input)
              assert.equal(commands, before + 1, 'control must dispatch its original command')
              const actual = path.resolve(workdir)
              const sameDrive = path.parse(actual).root.toLowerCase() === path.parse(intended).root.toLowerCase()
              const matches = sameDrive && !control.isError && control.value.exitCode === 0 && control.value.stdout.text.trim() === 'EXPECTED'
              if (!matches) {
                // DSH passes a single leading slash through to Windows. It can
                // resolve on the host process drive instead of the fixture drive.
                assert.equal(workdir, driveRooted, 'the drive-qualified dot path must read EXPECTED')
                assert.equal(sameDrive, false, 'a rooted path on the fixture drive must read EXPECTED')
                const missing = error => ['ENOENT', 'ENOTDIR'].includes(error.code)
                if (control.isError) {
                  assert.match(control.error.message, /\b(?:ENOENT|ENOTDIR)\b|\bWin32 (?:2|3|267)\b/i)
                  await assert.rejects(stat(actual), missing)
                } else if (control.value.exitCode !== 0) {
                  assert.equal(control.value.exitCode, 1)
                  assert.match(control.value.stderr.text, /stamp\.txt/i)
                  await assert.rejects(stat(path.join(actual, 'stamp.txt')), missing)
                } else {
                  assert.equal(control.value.stdout.text.trim(), (await readFile(path.join(actual, 'stamp.txt'), 'utf8')).trim())
                }
              }
              const checked = await h.call('pwsh', input)
              assert.equal(checked.isError, !matches, workdir)
              assert.equal(commands, before + 1 + Number(matches), 'an unverified directory must never receive the command')
              if (matches) {
                assert.equal(checked.value.exitCode, 0)
                assert.equal(checked.value.stdout.text.trim(), 'EXPECTED')
              }
            }
          }
        }
      })
  }
}
