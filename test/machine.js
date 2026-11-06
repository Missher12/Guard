import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import LocalFs from '@deepseek-ai/dsh-fs-local'
import PwshLocal from '@deepseek-ai/dsh-pwsh-local'
import PwshSandbox from '@deepseek-ai/dsh-pwsh-sandbox'
import SandboxLocal from '@deepseek-ai/dsh-sandbox-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import * as FileTools from '@deepseek-ai/dsh-tool-fs'
import { createHost } from './host.js'

const answerFile = '答案 [1].txt'
const logFile = '构建 [1].log'
const repeated = '正在构建 build step'
const readText = result => result.content.map(block => block.text ?? '').join('\n')
const hasPwsh = assembly => assembly.tools.some(tool => tool.name === 'pwsh')

async function workspace(action) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'dsh guard 中文 [work] '))
  try {
    await writeFile(path.join(cwd, answerFile), 'answer=42\n')
    // The BOM also gives Windows PowerShell 5.1 an explicit UTF-8 encoding.
    await writeFile(path.join(cwd, logFile), '\uFEFF' + (repeated + '\r\n').repeat(80) + 'BUILD OK\r\n')
    return await action(cwd)
  } finally { await rm(cwd, { recursive: true, force: true, maxRetries: 3 }) }
}

async function machine(cwd, { guard, pwshPath, mode, pluginEntry }, action) {
  const metrics = { probes: 0, shellBodies: 0 }
  const h = await createHost({ cwd, guard, pluginEntry, sandboxMode: mode, config: { probeTimeoutMs: 15000 },
    async installShell(ctx) {
      await ctx.plugin(Subprocess)
      if (mode) await ctx.plugin(SandboxLocal)
      // Count at the real executor boundary, without replacing its behavior.
      const Base = mode ? PwshSandbox : PwshLocal
      class CountedShell extends Base {
        execute(spec) {
          metrics[spec.command.includes('DSHWIN1:') ? 'probes' : 'shellBodies']++
          return super.execute(spec)
        }
      }
      await ctx.plugin(CountedShell, pwshPath ? { pwshPath } : {})
    },
    async installRead(ctx) {
      await ctx.plugin(LocalFs, { cwd })
      await ctx.plugin(FileTools, { read: true, readImage: false, write: false, edit: false, applyPatch: false })
    },
  })
  try { return await action(h, metrics) } finally { await h.close() }
}

/** Real executor, real files, same tool-selection policy on both sides; no model. */
export async function nativeSamples(pwshPath, { includeLog = true, pluginEntry } = {}) {
  return workspace(async cwd => {
    const samples = {}
    for (const task of includeLog ? ['missing-shell', 'repeated-log'] : ['missing-shell']) {
      const gone = task === 'missing-shell'
      samples[task] = {}
      for (const guard of [false, true]) samples[task][guard ? 'after' : 'before'] = await machine(cwd, {
        guard, pluginEntry, pwshPath: gone ? path.join(cwd, 'missing-pwsh.exe') : pwshPath,
      }, async (h, metrics) => {
        const assembly = await h.step()
        const header = assembly.sections.map(s => s.text).join('\n') + '\n' + JSON.stringify(assembly.tools)
        const results = []
        let failures = 0
        const call = async (name, args) => {
          const result = await h.call(name, args)
          results.push(readText(result))
          if (result.isError) failures++
          return result
        }
        assert.equal(hasPwsh(assembly), !(gone && guard), 'unexpected pwsh visibility')
        if (gone) {
          if (hasPwsh(assembly)) assert.equal((await call('pwsh', {
            command: "Get-Content -LiteralPath '" + answerFile + "'", description: 'Read answer file',
          })).isError, true)
          const result = await call('read', { file_path: answerFile })
          assert.equal(result.isError, false, readText(result))
          assert.match(readText(result), /answer=42/)
        } else {
          const result = await call('pwsh', { command: "Get-Content -LiteralPath '" + logFile + "'", description: 'Read build log' })
          assert.equal(result.isError, false, readText(result))
          assert.equal(result.value.exitCode, 0)
          assert.equal(result.value.stdout.text.split(repeated).length - 1, 80, 'canonical stdout must be lossless')
          assert.match(readText(result), /BUILD OK/)
          assert.equal(readText(result).includes('79 more times'), guard)
        }
        assert.equal(metrics.probes, guard ? 1 : 0)
        assert.equal(metrics.shellBodies, gone && guard ? 0 : 1)
        assert.equal(failures, gone && !guard ? 1 : 0)
        return { header, results, calls: results.length, failures, ...metrics }
      })
    }
    return samples
  })
}

/** Compare visibility with an independent real command in the same mode. */
export async function nativeEnvironmentChecks(pwshPath, pluginEntry) {
  return workspace(async cwd => {
    const summary = []
    for (const mode of [undefined, 'read-only', 'workspace-write']) {
      const command = { command: "Write-Output 'DSH-CONTROL-OK'", description: 'Check actual sandbox' }
      const control = await machine(cwd, { pwshPath, mode, guard: false }, async h => {
        const result = await h.call('pwsh', command)
        return !result.isError && result.value?.sandbox?.mode === mode && result.value.exitCode === 0 &&
          !result.value.sandbox?.denied && result.value.stdout.text.trim() === 'DSH-CONTROL-OK'
      })
      await machine(cwd, { pwshPath, mode, guard: true, pluginEntry }, async (h, metrics) => {
        assert.equal(hasPwsh(await h.step()), control, 'guard disagrees with the real ' + (mode ?? 'local') + ' executor')
        const result = await h.call('pwsh', command)
        assert.equal(result.isError, !control, readText(result))
        if (control) {
          assert.match(readText(result), /DSH-CONTROL-OK/)
          assert.equal(result.value.sandbox?.mode, mode)
        }
        assert.equal(metrics.probes, 1)
        assert.equal(metrics.shellBodies, control ? 1 : 0)
        const file = await h.call('read', { file_path: answerFile })
        assert.equal(file.isError, false, readText(file))
        assert.match(readText(file), /answer=42/)
      })
      summary.push({ mode: mode ?? 'local', available: control })
    }
    return summary
  })
}
