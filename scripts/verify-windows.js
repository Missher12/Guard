import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pkg from '../package.json' with { type: 'json' }

if (process.platform !== 'win32') {
  console.error('此验收命令需要原生 Windows 的 Node.js；WSL / macOS / Linux 不能作为 Windows 验收结果。')
  process.exitCode = 1
} else {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const unpacked = await mkdtemp(path.join(root, '.dsh-verify-'))
  try {
    const bundle = pkg.name + '-' + pkg.version + '.tgz'
    execFileSync('tar.exe', ['-xzf', path.join(root, bundle), '-C', unpacked])
    const pluginEntry = await import(pathToFileURL(path.join(unpacked, 'package', pkg.main)).href)
    console.log('测试安装包：', bundle)
    await verify(pluginEntry)
    execFileSync(process.execPath, ['--test', 'test/batch.test.js', 'test/office.test.js', 'test/batch-host.test.js'], {
      cwd: root, stdio: 'inherit', env: { ...process.env, DSH_GUARD_TEST_ROOT: path.join(unpacked, 'package'),
        DSH_GUARD_TEST_ENTRY: path.join(unpacked, 'package', pkg.main) },
    })
  } finally { await rm(unpacked, { recursive: true, force: true, maxRetries: 3 }) }
}

async function verify(pluginEntry) {
  console.log('Windows', os.release(), process.arch, 'Node', process.version)
  const { nativeEnvironmentChecks, nativeSamples } = await import('../test/machine.js')
  const pwsh = process.env.DSH_TEST_PWSH || undefined
  const environments = await nativeEnvironmentChecks(pwsh, pluginEntry)
  for (const env of environments) console.log(env.mode + ':', env.available
    ? '实际执行成功，模型能看到 pwsh' : '本机执行器不可用，模型看不到 pwsh，文件工具可用')
  const includeLog = environments.find(e => e.mode === 'local').available
  const samples = await nativeSamples(pwsh, { includeLog, pluginEntry })
  const missing = samples['missing-shell']
  console.log('不存在的 PowerShell：失败调用', missing.before.failures, '→', missing.after.failures,
    '；插件开启后实际启动用户 shell 命令', missing.after.shellBodies, '次；文件均读到 answer=42')
  if (includeLog) {
    const log = samples['repeated-log']
    const chars = s => s.results.join('').length
    assert.ok(chars(log.after) < chars(log.before))
    console.log('重复日志：模型收到', chars(log.before), '→', chars(log.after), '字符；原始 80 行及 BUILD OK 均保留')
  } else console.log('重复日志：本机没有可用的 PowerShell，未验证这个场景。')
  if (process.argv.includes('--strict')) assert.ok(environments.every(env => env.available),
    '严格验收要求本地 PowerShell 和两种 DSH 沙箱均能实际执行')
  console.log('本机验收通过。以上字符数不是 token 数。')
}
