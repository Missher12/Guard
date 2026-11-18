import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

export const mcpName = 'mcp__guard_fixture__lookup'

export async function loadMcpFixtureClient() {
  try {
    const client = await import('@deepseek-ai/dsh-mcp-client')
    if (typeof client.connectionStatusOf === 'function') return client
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error
  }
}

export async function waitUntil(predicate, message) {
  const end = Date.now() + 10000
  while (!predicate()) {
    assert(Date.now() < end, message)
    await setTimeout(25)
  }
}

export async function openMcpFixture(client, { pluginEntry, ambiguous = false, expandTemplates = true, late = false } = {}) {
  const { createHost } = await import('./host.js')
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'guard-mcp-'))
  const stop = path.join(cwd, 'offline')
  let h, scope
  const mount = ctx => ctx.plugin(client, { transport: 'stdio', serverName: 'guard_fixture', command: process.execPath,
    args: [fileURLToPath(import.meta.url), '--server', stop], cwd, expandTemplates,
    startupTimeoutMs: 12000, closeTimeoutMs: 3000, toolCallTimeoutMs: 3000, failOnStartupError: true,
    reconnect: { initialDelayMs: 500, maxDelayMs: 1000, maxAttempts: 3 } })
  try {
    let handle
    h = await createHost({ cwd, nativeEntry: true, pluginEntry, async installRead(ctx) {
      scope = ctx
      if (ambiguous) ctx.tools.register(fallbackDefinition('mcp__guard_fixture__foreign'))
      if (!late) await (handle = mount(ctx))
    } })
    if (late) await (handle = mount(scope))
    h.register('read')
    const status = client.connectionStatusOf(handle)
    assert.equal(status.current().state, 'connected')
    return { ...h, async disconnect() {
      await writeFile(stop, '')
      await waitUntil(() => ['reconnecting', 'connecting'].includes(status.current().state), 'real stdio transport did not disconnect')
    }, async reconnect() {
      await rm(stop)
      await waitUntil(() => status.current().state === 'connected', 'real stdio transport did not reconnect')
    }, async close() {
      try { await h.close() } finally { await rm(cwd, { force: true, recursive: true }) }
    } }
  } catch (error) {
    try { await h?.close() } finally { await rm(cwd, { force: true, recursive: true }) }
    throw error
  }
}

export function fallbackDefinition(name) {
  return { name, description: 'Independent fixture tool', parameters: { type: 'object' },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'independent' }
}

if (process.argv[2] === '--server') {
  const stop = process.argv[3]
  // A replacement transport can start while offline, but cannot finish its
  // handshake until the fixture allows recovery.
  const crash = setInterval(() => { if (ready && existsSync(stop)) process.exit(0) }, 20)
  let ready = false
  const input = createInterface({ input: process.stdin })
  input.once('close', () => clearInterval(crash))
  for await (const line of input) {
    const { id, method, params } = JSON.parse(line)
    if (id === undefined) continue
    let result = {}
    if (method === 'initialize') {
      while (existsSync(stop)) await setTimeout(20)
      result = { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'guard-audit', version: '1' } }
      ready = true
    } else if (method === 'tools/list') {
      result = { tools: [{ name: 'lookup', description: 'Read a synthetic marker', inputSchema: { type: 'object' } }] }
    } else if (method === 'tools/call') {
      result = { content: [{ type: 'text', text: 'answer=42' }] }
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
  }
}
