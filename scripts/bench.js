import assert from 'node:assert/strict'
import { createHost } from '../test/host.js'

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

const native = process.argv.includes('--native')
if (native && process.platform !== 'win32' && !process.env.DSH_TEST_PWSH)
  throw Error('Set DSH_TEST_PWSH to a real PowerShell executable when exercising native samples outside Windows.')
const data = native ? await (await import('../test/machine.js')).nativeSamples(process.env.DSH_TEST_PWSH) : {}
if (!native) for (const name of ['missing-shell', 'repeated-log', 'quiet-read'])
  data[name] = { before: await sample(name, false), after: await sample(name, true) }
if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(data))
else {
  for (const [task, pair] of Object.entries(data)) for (const [side, s] of Object.entries(pair)) {
    console.log(task, side, { headerChars: s.header.length, resultChars: s.results.join('').length,
      modelCallsToTools: s.calls, failedCalls: s.failures, localProbes: s.probes })
  }
}
