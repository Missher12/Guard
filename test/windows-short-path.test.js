import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import PwshLocal from '@deepseek-ai/dsh-pwsh-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { createHost } from './host.js'

const run = promisify(execFile)
const read = "Get-Content -LiteralPath 'stamp.txt' -Raw -ErrorAction Stop; $PWD.ProviderPath"

async function shortPath(directory) {
  const script = "$ErrorActionPreference='Stop'; $f=(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:GUARD_SHORT_NAME_FIXTURE); " +
    '[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($f.ShortPath))'
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { env: { ...process.env, GUARD_SHORT_NAME_FIXTURE: directory }, windowsHide: true })
  const alias = Buffer.from(stdout.trim(), 'base64').toString('utf16le')
  assert.ok(path.isAbsolute(alias), 'FileSystemObject must return the directory path')
  return alias
}

async function readMarker(host, workdir) {
  const result = await host.call('pwsh', { command: read, description: 'Read marker and provider path', ...(workdir && { workdir }) })
  if (result.isError) return { error: result.error?.message ?? 'tool refused' }
  assert.equal(result.value.exitCode, 0)
  const [marker, actual] = result.value.stdout.text.trim().split(/\r?\n/)
  assert.ok(path.isAbsolute(actual), 'PowerShell must report its actual directory')
  return { marker, actual }
}

for (const shell of ['powershell.exe', 'pwsh.exe']) {
  for (const bracketBase of [false, true]) {
    const scenario = bracketBase ? 'checks an explicit expanded spelling of the bracket-free session alias'
      : 'accepts a real 8.3 alias but still checks a bracketed sibling under it'
    test(shell + ' ' + scenario,
    { skip: process.platform !== 'win32' }, async t => {
      const created = await mkdtemp(path.join(os.tmpdir(), 'guard long alias fixture '))
      assert.equal(path.dirname(created), path.resolve(os.tmpdir()))
      t.after(() => rm(created, { recursive: true, force: true, maxRetries: 3 }))
      const directory = await realpath(created)
      const intended = path.join(directory, 'project[1]')
      const sibling = path.join(directory, 'project1')
      await Promise.all([mkdir(intended), mkdir(sibling)])
      for (const [dir, marker] of [[directory, 'ROOT'], [intended, 'EXPECTED'], [sibling, 'NEIGHBOR']])
        await writeFile(path.join(dir, 'stamp.txt'), marker)
      const sessionPath = bracketBase ? intended : directory
      const rootMarker = bracketBase ? 'EXPECTED' : 'ROOT'
      const alias = await shortPath(sessionPath)
      if (path.normalize(alias).toLowerCase() === path.normalize(sessionPath).toLowerCase())
        return t.skip('the fixture volume provided no distinct 8.3 path')
      if (bracketBase && (alias.includes('[') || alias.includes(']')))
        return t.skip('the bracketed fixture has no bracket-free 8.3 path')
      assert.equal(await readFile(path.join(alias, 'stamp.txt'), 'utf8'), rootMarker)

      let bodies = 0
      const probes = []
      const options = { cwd: alias, async installShell(ctx) {
        await ctx.plugin(Subprocess)
        class Counted extends PwshLocal {
          execute(spec) {
            if (spec.command === read) bodies++
            else probes.push(spec.workdir)
            return super.execute(spec)
          }
        }
        await ctx.plugin(Counted, { pwshPath: shell })
      } }
      const bracket = bracketBase ? intended : path.join(alias, 'project[1]')
      const control = await createHost({ ...options, guard: false })
      t.after(control.close)
      const root = await readMarker(control)
      // Some Windows PowerShell builds expand a short alias before processing
      // the brackets; the unguarded default itself then reaches the sibling.
      const rootCorrect = root.marker === rootMarker
      if (!rootCorrect) {
        assert.ok(bracketBase && shell === 'powershell.exe', root.error)
        assert.equal(root.marker, 'NEIGHBOR')
      }
      assert.equal(await realpath(root.actual), rootCorrect ? sessionPath : await realpath(sibling))
      const unguarded = await readMarker(control, bracket)
      assert.ok(['NEIGHBOR', 'EXPECTED'].includes(unguarded.marker), unguarded.error)
      if (shell === 'pwsh.exe') assert.equal(unguarded.marker, 'EXPECTED')
      const correct = unguarded.marker === 'EXPECTED'
      assert.equal(await realpath(unguarded.actual), await realpath(correct ? intended : sibling))
      assert.equal(bodies, 2)

      const guarded = await createHost(options)
      t.after(guarded.close)
      assert.equal((await guarded.step()).tools.some(tool => tool.name === 'pwsh'), rootCorrect,
        'wrong visibility: ' + JSON.stringify({ requested: alias, actual: root.actual }))
      const guardedRoot = await readMarker(guarded)
      if (rootCorrect) assert.deepEqual(guardedRoot, root)
      else assert.ok(guardedRoot.error)
      const countBeforeOverride = probes.length
      const checked = await readMarker(guarded, bracket)
      // A different spelling needs its own check even when this PowerShell
      // happens to read the right file through both the alias and expansion.
      if (rootCorrect) assert.ok(probes.slice(countBeforeOverride).includes(bracket), 'override spelling was not probed')
      if (rootCorrect && correct) assert.deepEqual(checked, unguarded)
      else assert.ok(checked.error, 'an unsafe directory must be refused before executing its body')
      assert.equal(bodies, 2 + Number(rootCorrect) + Number(rootCorrect && correct))
    })
  }
}
