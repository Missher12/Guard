import assert from 'node:assert/strict'
import test from 'node:test'
import { fallbackDefinition, loadMcpFixtureClient, mcpName, openMcpFixture } from './mcp-fixture.js'

const client = await loadMcpFixtureClient()
if (process.env.DSH_REQUIRE_MCP_STATUS === '1') assert(client, 'the test requires a host with published MCP connection status')
const hidden = { skip: !client && 'needs a host SDK with connection status', timeout: 25000 }
const advertised = (prompt, name = mcpName) => prompt.tools.some(tool => tool.name === name)

test('a known MCP outage hides the actual registered tool before its first failed call and restores on reconnect', hidden, async t => {
  const h = await openMcpFixture(client, { late: true })
  t.after(h.close)
  assert(advertised(await h.step()))
  const sibling = await h.addAgent('sibling')
  await h.disconnect()
  assert(!advertised(await h.step()), 'the client is offline before any tool failure')
  assert(!advertised(await h.step(sibling)))
  await h.usePtc(sibling)
  assert(!(await h.step(sibling)).sections.find(s => s.name === 'tools:sdk').text.includes(mcpName))
  const refused = await h.call(mcpName)
  assert.equal(refused.isError, true)
  assert.match(refused.error?.message, /connection unavailable/)
  const local = h.agent.ctx.tools.register(fallbackDefinition(mcpName))
  try {
    assert(advertised(await h.step()), 'an agent-owned shadow must stay available')
    const result = await h.call(mcpName)
    assert.equal(result.isError, false)
    assert.equal(result.value, 'independent')
  } finally { local() }
  await h.reconnect()
  assert(advertised(await h.step()))
  assert((await h.step(sibling)).sections.find(s => s.name === 'tools:sdk').text.includes(mcpName))
  const result = await h.call(mcpName)
  assert.equal(result.isError, false)
  assert.match(result.content[0].text, /answer=42/)
})

test('ambiguous shared namespaces keep their existing availability until an exact failure', hidden, async t => {
  const h = await openMcpFixture(client, { ambiguous: true, expandTemplates: false })
  t.after(h.close)
  await h.disconnect()
  assert(advertised(await h.step()), 'a namespace with unverified ownership cannot hide an entire group of tools')
  const result = await h.call('mcp__guard_fixture__foreign')
  assert.equal(result.isError, false)
  assert.equal(result.value, 'independent')
})
