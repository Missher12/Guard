import assert from 'node:assert/strict'
import test from 'node:test'
import { probeShell, incompatibleCommand } from '../src/probe.js'
import { compactShellResult } from '../src/compact.js'

function backend(output, changes = {}) {
  let received
  const shell = {
    resolve(request) { received = request; return request },
    async execute() {
      return { async result() {
        return { exitCode: 0, stdout: { text: output }, ...changes }
      } }
    },
  }
  return { shell, request: () => received }
}

test('the probe uses the selected DSH executor, session policy, cwd and deadline', async () => {
  const cwd = 'C:\\中文 目录\\[work]'
  const sandboxPolicy = { mode: 'read-only', workspaceRoot: cwd }
  const host = backend('DSHWIN1:5:grep,awk\r\n')
  const facts = await probeShell('pwsh', host.shell, { cwd, sandboxPolicy })
  assert.equal(facts.ready, true)
  assert.equal(facts.major, 5)
  assert.deepEqual([...facts.available], ['grep', 'awk'])
  assert.equal(host.request().sandboxPolicy, sandboxPolicy)
  assert.equal(host.request().workdir, cwd)
  assert.match(host.request().command, /Get-Command/)
  assert.ok(host.request().signal instanceof AbortSignal)
  assert.equal(host.request().onExpiry, 'kill')
})

test('an exit code alone, truncated data or a marker in an error cannot attest a shell', async () => {
  for (const output of ['', 'DSHWIN1:bash', 'DSHWIN1:0:', 'DSHWIN1:7:invented']) {
    assert.equal((await probeShell('pwsh', backend(output).shell, {})).ready, false)
  }
  for (const changes of [{ exitCode: 1 }, { timedOut: true }, { aborted: true },
    { signal: 'SIGTERM' }, { sandbox: { denied: true } }, { stdout: { text: 'DSHWIN1:7:', truncated: true } }]) {
    assert.equal((await probeShell('pwsh', backend('DSHWIN1:7:', changes).shell, {})).ready, false)
  }
  assert.equal((await probeShell('bash', backend('DSHWIN1:bash\n').shell, {})).ready, true)
})

test('the deadline releases the session even if the provider ignores cancellation during launch or collection', async () => {
  for (const stage of ['launch', 'result']) {
    let signal
    let settle
    const stuck = new Promise(resolve => { settle = resolve })
    const shell = { resolve: spec => spec, execute(spec) {
      signal = spec.signal
      return stage === 'launch' ? stuck : { result: () => stuck }
    } }
    const timer = setTimeout(() => settle(undefined), 600)
    try {
      const outcome = await Promise.race([probeShell('pwsh', shell, { timeoutMs: 30 }),
        new Promise(resolve => { signal.addEventListener('abort', () => setTimeout(() => resolve('still waiting'), 60), { once: true }) })])
      assert.equal(outcome?.ready, false, 'session is still waiting for ' + stage)
      assert.equal(signal.aborted, true)
    } finally { clearTimeout(timer); settle(undefined) }
  }
})

test('reject only conclusive PowerShell mismatches; preserve quoting, scripts and real Unix tools', () => {
  const ps5 = { ready: true, major: 5, available: new Set(['grep']) }
  const ps7 = { ...ps5, major: 7 }
  for (const command of ['sed -n 1p file', 'rg needle .', 'jq . data.json', 'git status && git diff', 'git status || exit']) {
    assert.ok(incompatibleCommand({ command }, ps5), command)
  }
  for (const command of ["Write-Output 'a && b'", 'Write-Output "a || b"', 'cmd /c "echo a && echo b"',
    'cmd /c echo a --% && echo b', 'git status # && placeholder', 'Write-Output `&`&',
    "Write-Output @'\na && b\n'@", 'Write-Output “a && b”', 'grep word file', '.\\sed.exe file', 'function sed { 1 }; sed',
    'Get-Content -LiteralPath ".\\file [1]"']) {
    assert.equal(incompatibleCommand({ command }, ps5), undefined, command)
  }
  assert.equal(incompatibleCommand({ command: 'a && b' }, ps7), undefined)
  assert.match(incompatibleCommand({ command: 'a && b' }, ps5), /if \(\$\?\)/)
  assert.match(incompatibleCommand({ command: 'a || b' }, ps5), /if \(-not \$\?\)/)
  assert.match(incompatibleCommand({ command: 'a && b || c' }, ps5), /if \(\$\?\).*if \(-not \$\?\)/)
  assert.equal(incompatibleCommand({ command: 'sed file', workdir: 'D:\\other' }, ps7), undefined)
})

test('fold only long runs of identical shell output lines; keep boundaries, errors and canonical values', () => {
  const line = '正在检查 build/资源 file'
  const body = Array(80).fill(line).join('\r\n') + '\r\nOK\r\n[exit code: 0]'
  const content = [{ type: 'text', text: body }, { type: 'text', text: 'short' }]
  const result = { content, value: { exitCode: 0, stdout: { text: body } } }
  const decision = { kind: 'accept', additionalContexts: [{}] }
  const compact = compactShellResult('pwsh', result, decision)
  assert.match(compact.content[0].text, /79/)
  assert.match(compact.content[0].text, /\r\nOK\r\n\[exit code: 0\]$/)
  assert.equal(compact.content[1], content[1])
  assert.equal(compact.additionalContexts, decision.additionalContexts)
  assert.equal(result.value.stdout.text, body)
  for (const [name, outcome, next] of [
    ['read', result, decision], ['pwsh', { ...result, isError: true }, decision],
    ['pwsh', { ...result, value: { exitCode: 1 } }, decision],
    ['pwsh', result, { kind: 'block', feedback: [] }],
    ['pwsh', result, { kind: 'accept', value: 'replacement' }],
    ['pwsh', result, { kind: 'accept', content: [] }],
    ['bash', { content: [{ type: 'text', text: 'x\nx\nx\n' }] }, decision],
  ]) assert.equal(compactShellResult(name, outcome, next), next)
})

test('do not replace a cheap four-line separator with a more expensive repetition marker', () => {
  // Official V4: each input is 9 tokens; the old marker costs 12.
  for (const char of [' ', '.']) {
    const body = (char.repeat(128) + '\n').repeat(4) + 'END'
    const result = { content: [{ type: 'text', text: body }], value: { exitCode: 0 } }
    const accept = { kind: 'accept' }
    assert.equal(compactShellResult('pwsh', result, accept), accept)
  }
})
