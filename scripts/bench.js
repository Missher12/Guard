import assert from 'node:assert/strict'
import { createHost } from '../test/host.js'
import { compactShellResult, renderBatchResult } from '../src/compact.js'

async function sample(task, guard) {
  const host = await createHost({ working: task !== 'missing-shell', guard })
  try {
    const assembly = await host.step()
    const header = assembly.sections.map(s => s.text).join('\n') + '\n' + JSON.stringify(assembly.tools)
    const results = []
    let failures = 0
    async function call(name, args) {
      const result = await host.call(name, args)
      results.push(result.content.map(b => b.text ?? '').join('\n'))
      if (result.isError) failures++
      return result
    }
    // Same selection policy on both runs. Try the advertised shell, then
    // the narrow file tool if necessary. No model or API key is involved.
    if (task === 'missing-shell') {
      if (assembly.tools.some(tool => tool.name === 'pwsh')) {
        const read = await call('pwsh', { command: 'Get-Content -LiteralPath value.txt', description: 'Read fixture' })
        assert.equal(read.isError, true)
      }
      assert.equal((await call('read', {})).content[0].text, 'answer=42')
    } else if (task === 'repeated-log') {
      const log = await call('pwsh', { command: 'Get-Content -LiteralPath build.log', description: 'Read build log' })
      assert.ok(log.value.stdout.text.endsWith('BUILD OK'))
      assert.match(log.content[0].text, /BUILD OK/)
    } else {
      assert.equal((await call('read', {})).content[0].text, 'answer=42')
    }
    return { header, results, calls: results.length, failures, probes: host.counts.probes }
  } finally { await host.close() }
}

async function disconnectedSample(guard) {
  const host = await createHost({ guard, async installRead(ctx) {
    ctx.tools.register({ name: 'mcp__remote__read', description: 'Read the remote fixture file',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => { throw Error('Not connected') } })
  } })
  host.register('read')
  const headers = [], results = []
  let failures = 0
  try {
    // Same deterministic policy over three steps: remote if advertised, then
    // local. This measures tool selection, not a model's autonomous behavior.
    for (let step = 0; step < 3; step++) {
      const prompt = await host.step()
      headers.push(prompt.sections.map(s => s.text).join('\n') + JSON.stringify(prompt.tools))
      if (prompt.tools.some(tool => tool.name === 'mcp__remote__read')) {
        const result = await host.call('mcp__remote__read')
        assert.equal(result.isError, true)
        failures++
        results.push(result.content[0].text)
      }
      const result = await host.call('read')
      assert.equal(result.value, 'answer=42')
      results.push(result.content[0].text)
    }
    return { header: headers.join('\n'), results, calls: results.length, failures, probes: host.counts.probes }
  } finally { await host.close() }
}

function renderingSample(text) {
  return { header: '', results: [text], calls: 1, failures: 0, probes: 0 }
}

const native = process.argv.includes('--native')
if (native && process.platform !== 'win32' && !process.env.DSH_TEST_PWSH)
  throw Error('Set DSH_TEST_PWSH to a real PowerShell executable when exercising native samples outside Windows.')
const data = native ? await (await import('../test/machine.js')).nativeSamples(process.env.DSH_TEST_PWSH) : {}
if (!native) for (const name of ['missing-shell', 'repeated-log', 'quiet-read'])
  data[name] = { before: await sample(name, false), after: await sample(name, true) }
if (!native) {
  data['disconnected-mcp'] = { before: await disconnectedSample(false), after: await disconnectedSample(true) }
  const log = '编译 compile source files\n检查 check assets and references\n'.repeat(80) + 'BUILD OK\n[exit code: 0]'
  const result = { content: [{ type: 'text', text: log }], value: { exitCode: 0, stdout: { text: log } } }
  data['multiline-log'] = { before: renderingSample(log),
    after: renderingSample(compactShellResult('bash', result, { kind: 'accept' }).content[0].text) }
  const value = { id: '00000000-0000-4000-8000-000000000001', status: 'completed',
    counts: { completed: 100, skipped: 0, failed: 0, pending: 0, uncertain: 0 },
    items: Array.from({ length: 100 }, (_, index) => ({ index, status: 'completed', target: `output/file-${index}.txt` })) }
  data['batch-receipt'] = { before: renderingSample(JSON.stringify(value)),
    after: renderingSample(renderBatchResult({ action: 'run' }, value)[0].text) }
}
if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(data))
else {
  for (const [task, pair] of Object.entries(data)) for (const [side, s] of Object.entries(pair)) {
    console.log(task, side, { headerChars: s.header.length, resultChars: s.results.join('').length,
      modelCallsToTools: s.calls, failedCalls: s.failures, localProbes: s.probes })
  }
}
