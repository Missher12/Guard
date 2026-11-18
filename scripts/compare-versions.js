import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import dshTools from '@deepseek-ai/dsh-tools/package.json' with { type: 'json' }
import candidateManifest from '../package.json' with { type: 'json' }
import * as candidate from '../src/index.js'
import { execute, openBatchFixture } from '../test/batch-fixture.js'
import { loadMcpFixtureClient, mcpName, openMcpFixture } from '../test/mcp-fixture.js'
import { python } from '../test/worker.js'

const [baselineDirectory, reportPath, requestedTrials = '3'] = process.argv.slice(2)
assert(baselineDirectory && reportPath, 'usage: node scripts/compare-versions.js <unpacked-v0.5.3> <report.json> [trials]')
const trials = Number(requestedTrials)
assert(Number.isInteger(trials) && trials >= 1 && trials <= 9)
assert.equal(dshTools.version, '0.2.2-rc.4')
const baselineRoot = path.resolve(baselineDirectory)
assert.equal(JSON.parse(await readFile(path.join(baselineRoot, 'package.json'), 'utf8')).version, '0.5.3')
// The unpacked baseline resolves the same official SDK as the candidate.
const deps = path.join(baselineRoot, 'node_modules')
try { await symlink(path.resolve('node_modules'), deps, 'junction') }
catch (error) { if (error.code !== 'EEXIST') throw error }
const baseline = await import(pathToFileURL(path.join(baselineRoot, 'src/index.js')).href)
const client = await loadMcpFixtureClient()
assert(client, 'the comparison requires the real MCP client status interface')

const batch = 'guard_file_batch'
const contentOf = result => result.content.map(block => block.text ?? '').join('\n')
function capture(h) {
  const start = performance.now()
  const turns = []
  let toolFailures = 0, failedItems = 0
  return {
    step: () => h.step(),
    async call(name, args, step) {
      step ??= await h.step()
      assert(step.tools.some(tool => tool.name === name), name + ' must be offered by the actual Native prompt')
      const result = await h.call(name, args)
      turns.push({ schema: step.sections.map(section => section.text).join('\n') + '\n' + JSON.stringify(step.tools),
        call: JSON.stringify({ name, arguments: args }), result: contentOf(result) })
      if (result.isError) toolFailures++
      failedItems += result.value?.counts?.failed ?? 0
      return result
    },
    finish: () => ({ elapsedMs: performance.now() - start, calls: turns.length,
      toolFailures, failedItems, redRows: toolFailures, turns }),
  }
}

async function inBatchWorkspace(pluginEntry, action) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'guard-compare-'))
  let host
  try {
    host = await openBatchFixture(root, { pluginEntry })
    return await action(root, host)
  } finally {
    try { await host?.close() } finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }) }
  }
}

async function sharedReplacement(pluginEntry, modern) {
  return inBatchWorkspace(pluginEntry, async (root, host) => {
    const files = Array.from({ length: 100 }, (_, i) => `第${String(i).padStart(3, '0')}份.md`)
    const edits = [{ oldText: '审批状态：等待项目负责人核对，暂不归档。', newText: '审批状态：已完成核对，允许归档。', count: 1 }]
    await Promise.all(files.map((file, i) => writeFile(path.join(root, file), `\ufeff编号 ${i}\r\n${edits[0].oldText}\r\n`)))
    const args = modern ? { action: 'run', files, edits }
      : { action: 'run', operations: files.map(source => ({ kind: 'replace_text', source, edits })) }
    const run = capture(host)
    const result = await run.call(batch, args)
    const measured = run.finish()
    assert.equal(result.isError, false, contentOf(result))
    assert.equal(result.value.counts.completed, 100, contentOf(result))
    const outputs = await Promise.all(files.map(file => readFile(path.join(root, file), 'utf8')))
    assert(outputs.every((body, i) => body === `\ufeff编号 ${i}\r\n${edits[0].newText}\r\n`))
    return measured
  })
}

// Seed a durable 0.5.3 receipt using its real worker and real completed files.
// Add a destination conflict after preflight, as can happen before a resume.
const seedPartial = `import pathlib, runpy, sys
root = pathlib.Path(sys.argv[1]).resolve()
worker = pathlib.Path(sys.argv[2]); sys.path.insert(0, str(worker.parent))
engine = runpy.run_path(str(worker))
source = root / 'source.txt'; source.write_text('verified contents', encoding='utf-8')
ops = [dict(kind='copy', source='source.txt', destination=f'out/item-{i:03}.txt') for i in range(100)]
items = engine['preflight'](root, ops)
assert all(row['status']=='pending' for row in items)
for row in items[:97]: engine['execute_item'](root, row, lambda: None, {})
store = root / '.dsh-guard'; store.mkdir()
identity = sys.argv[3]
meta = root.stat()
engine['atomic_json'](store / (identity + '.json'), dict(id=identity, root=str(root),
    rootIdentity=[str(meta.st_dev), str(meta.st_ino)], onError='stop', session=sys.argv[4], family='files', items=items))
(root / 'out/item-097.txt').write_text('existing destination', encoding='utf-8')`

async function partialResume(pluginEntry, modern) {
  return inBatchWorkspace(pluginEntry, async (root, host) => {
    const id = '00000000-0000-4000-8000-000000000006'
    await execute(python, ['-B', '-c', seedPartial, root, path.join(baselineRoot, 'src/batch-worker.py'), id, host.agent.session.id])
    const completed = path.join(root, 'out/item-000.txt')
    const before = await stat(completed, { bigint: true })
    const run = capture(host)
    const partial = await run.call(batch, { action: 'resume', id })
    assert.equal(partial.value?.status, 'partial', contentOf(partial))
    assert.deepEqual(partial.value.counts, { completed: 97, skipped: 0, failed: 1, pending: 2, uncertain: 0 })
    const result = JSON.parse(contentOf(partial))
    assert.match((modern ? result.exceptions[0] : result.items[97]).error, /目标已存在/)
    if (modern) assert.deepEqual(result.resumeAfterFix, { action: 'resume', id })
    await rm(path.join(root, 'out/item-097.txt'))
    const resumed = await run.call(batch, { action: 'resume', id })
    assert.equal(resumed.value?.counts.completed, 100, contentOf(resumed))
    const details = await run.call(batch, { action: 'status', id })
    const measured = run.finish()
    assert.equal(details.value?.items.length, 100)
    const after = await stat(completed, { bigint: true })
    assert.equal(before.ino, after.ino)
    assert.equal(before.mtimeNs, after.mtimeNs)
    for (const row of details.value.items) {
      assert.equal(await readFile(path.join(root, row.target), 'utf8'), 'verified contents')
    }
    return measured
  })
}

async function knownOfflineMcp(pluginEntry, modern) {
  const host = await openMcpFixture(client, { pluginEntry })
  try {
    assert((await host.step()).tools.some(tool => tool.name === mcpName))
    await host.disconnect()
    const run = capture(host)
    const step = await run.step()
    const offered = step.tools.some(tool => tool.name === mcpName)
    assert.equal(offered, !modern)
    if (offered) assert.equal((await run.call(mcpName, {}, step)).isError, true)
    const fallback = await run.call('read', {}, offered ? undefined : step)
    const measured = run.finish()
    assert.equal(fallback.value, 'answer=42')
    await host.reconnect()
    const restored = await host.call(mcpName)
    assert.equal(restored.isError, false, contentOf(restored))
    assert.match(contentOf(restored), /answer=42/)
    return measured
  } finally { await host.close() }
}

const results = {}
for (const [name, measure] of Object.entries({ sharedReplacement, partialResume, knownOfflineMcp })) {
  results[name] = { baseline: [], candidate: [] }
  for (let i = 0; i < trials; i++) {
    // Alternate run order to limit warm-cache and runner load bias.
    for (const modern of i % 2 ? [true, false] : [false, true]) {
      const side = modern ? 'candidate' : 'baseline'
      const measured = await measure(modern ? candidate : baseline, modern)
      results[name][side].push(measured)
      console.log(name, side, 'trial', i + 1, Math.round(measured.elapsedMs) + ' ms',
        measured.calls + ' calls', measured.toolFailures + ' failed tool calls', measured.failedItems + ' failed batch items')
    }
  }
}
await writeFile(reportPath, JSON.stringify({ platform: process.platform, arch: process.arch,
  dsh: dshTools.version, baseline: '0.5.3', candidate: candidateManifest.version, trials, results }, null, 2) + '\n')
