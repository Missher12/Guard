import assert from 'node:assert/strict'
import test from 'node:test'
import { symbols } from '@deepseek-ai/cordis'
import { createHost, pwshMarker } from './host.js'

const oldError = "which : 无法将“which”项识别为 cmdlet 的名称。\r\n" +
  "    + CategoryInfo          : ObjectNotFound: (which:String) [], CommandNotFoundException\r\n" +
  "    + FullyQualifiedErrorId : CommandNotFoundException\r\n \r\n"
const newError = "which: The term 'which' is not recognized as a name of a cmdlet, function, script file, or executable program.\r\n" +
  "Check the spelling of the name, or if a path was included, verify that the path is correct and try again.\r\n"

async function fixture(t, major, observed = 'rg', discovery = 'open') {
  const h = await createHost({ config: { compactOutput: false }, probeResult: { exitCode: 0,
    stdout: { text: pwshMarker(process.cwd(), major, observed, discovery) } } })
  t.after(h.close)
  const state = { stderr: major === 5 ? oldError : newError, result: {}, calls: 0 }
  const shell = h.ctx.get('shell')
  t.mock.method(shell[symbols.original] ?? shell, 'execute', async () => {
    state.calls++
    return { result: async () => ({ exitCode: 1, signal: null, timedOut: false, aborted: false, timeoutMs: 5000,
      stdout: { text: '', truncated: false }, stderr: { text: state.stderr, truncated: false }, ...state.result }) }
  })
  return { ...h, state, run: command => h.call('pwsh', { description: 'Look up tool', command }) }
}

for (const major of [5, 7]) {
  test('PS ' + major + ' confirmed missing command gets native advice before the exit marker', async t => {
    const h = await fixture(t, major)
    const result = await h.run("which 'rg'")
    assert.equal(result.isError, false)
    assert.equal(result.value.exitCode, 1)
    assert.equal(result.value.stderr.text, h.state.stderr)
    assert.equal(result.content[0].text, '[stderr]\n' + h.state.stderr + 'Try Get-Command.\n[exit code: 1]')
    assert.equal(h.state.calls, 1, 'no automatic retry')
  })
}

test('version and help queries keep the original failure without suggesting another program', async t => {
  const h = await fixture(t, 7, '')
  for (const name of ['awk', 'chmod', 'grep', 'head', 'jq', 'rg', 'sed', 'tail', 'touch', 'which']) {
    h.state.stderr = newError.replaceAll('which', name)
    for (const option of ['--version', '-V', '--help', '-h', '"--version"', "'-h'", '--version --help', 'version']) {
      const { content, value } = await h.run(name + ' ' + option)
      assert.equal(value.stderr.text, h.state.stderr)
      assert.equal(content[0].text, '[stderr]\n' + h.state.stderr + '[exit code: 1]', name + ' ' + option)
    }
  }
})

test('a missing jq used to read JSON still gets the native parsing alternative', async t => {
  const h = await fixture(t, 7)
  h.state.stderr = newError.replaceAll('which', 'jq')
  const result = await h.run('jq . file.json')
  assert.equal(result.content[0].text, '[stderr]\n' + h.state.stderr + 'Try ConvertFrom-Json.\n[exit code: 1]')
})

for (const discovery of ['open', 'closed']) {
  test(discovery + ' discovery gives advice only for recognized operations', async t => {
    const h = await fixture(t, 7, '', discovery)
    for (const [command, expected] of [
      ['rg --files', 'Get-ChildItem -File -Recurse -Name'], ["which 'cmd.exe'", 'Get-Command'],
      ["jq . '中文 目录\\data.json'", 'ConvertFrom-Json'], ["jq '.' file.json", 'ConvertFrom-Json'],
      ['jq --version'], ['jq --help'], ["jq -n '{ok: true}'"], ['jq . -V'], ['jq . one.json two.json'],
      ['jq . \'file.json"'],
      ['rg --files -g "*.js"'], ['rg --FILES'], ['rg -n pattern .'], ['which -a git'], ['awk --help'], ['touch -r ref target'],
    ]) {
      const head = command.split(' ')[0]
      h.state.stderr = newError.replaceAll('which', head)
      const result = await h.run(command)
      if (discovery === 'closed') {
        assert.equal(result.isError, true)
        const unavailable = head + ' is unavailable in this PowerShell session.'
        assert.ok(result.content[0].text.includes(unavailable), command)
        if (expected) assert.ok(result.content[0].text.includes('Use ' + expected + '.'), command)
        else assert.doesNotMatch(result.content[0].text, /\b(?:Use|Try) /, command)
        assert.equal(h.state.calls, 0)
      } else {
        const hint = expected ? 'Try ' + expected + '.\n' : ''
        assert.equal(result.content[0].text, '[stderr]\n' + h.state.stderr + hint + '[exit code: 1]', command)
      }
    }
  })
}

test('command lookup hint is conditional and an open discovery policy still admits which', async t => {
  for (const observed of ['rg', 'which']) {
    const h = await fixture(t, 7, observed)
    const prompt = (await h.step()).sections.find(section => section.name === 'tool:pwsh').text
    assert.equal(prompt.includes('Get-Command'), observed !== 'which')
    const result = await h.run('which rg')
    assert.equal(h.state.calls, 1)
    assert.equal(result.isError, false)
    assert.equal(result.content[0].text.includes('Try Get-Command.'), observed !== 'which')
  }
})

test('ambiguous shell text, unrelated errors and nonstandard outcomes are left intact', async t => {
  const h = await fixture(t, 7)
  for (const [command, stderr, result = {}] of [
    ['which rg; exit 1', newError], ['which $(Get-Date)', newError], ['which rg | Out-Null', newError],
    ["which 'rg’ ; exit 1 # '", newError], ['which rg\n', newError],
    ['where rg', newError], ['which rg', newError.replaceAll('which', 'jq')], ['which rg', "which: access denied\r\n"],
    ['which rg', newError, { timedOut: true }], ['which rg', newError, { sandbox: { denied: true, mode: 'read-only' } }],
    ['which rg', newError, { sandbox: { mode: 'read-only', runnerFailed: true } }],
    ['which rg', newError, { stderr: { text: newError, truncated: true } }],
    ['which rg', newError, { stdout: { text: 'other output', truncated: false } }],
  ]) {
    Object.assign(h.state, { stderr, result })
    const output = await h.run(command)
    assert.doesNotMatch(output.content[0].text, /Try Get-Command/, command)
  }
})

test('a downstream content override is preserved', async t => {
  const h = await fixture(t, 7)
  h.ctx.on('tools/post-execute', async (_exec, _result, next) => ({
    ...await next(), content: [{ type: 'text', text: 'owner presentation' }],
  }))
  assert.equal((await h.run('which rg')).content[0].text, 'owner presentation')
})
