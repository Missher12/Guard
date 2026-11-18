// Only transport-level diagnostics with a known MCP spelling. A business
// error, timeout or authorization refusal does not establish tool availability.
// rc.3's SDK and credential-template redaction add the final three forms.
const disconnectMessages = new Set([
  'Not connected',
  'MCP error -32000: Connection closed',
  'MCP error -32000: Not connected',
  'Error: MCP connection closed',
  'SdkError: Error: MCP connection closed',
  'Error: Not connected',
])

export function disconnectedMcp(name, result) {
  return /^mcp__/.test(name) && result.isError && disconnectMessages.has(result.error?.message)
}
import { symbols } from '@deepseek-ai/cordis'
import { scopeOf, scopeParentOf } from '@deepseek-ai/dsh-scope'


const disconnectedStates = new Set(['connecting', 'reconnecting', 'waiting-credentials', 'failed', 'closed'])

// Attribute definitions only while the official client reports a complete
// connected generation. Scope, namespace, and tool count must all agree.
// Offline checks then use exact definition identities, never a prefix mask.
export async function watchMcpConnections(ctx) {
  const available = () => false
  if (typeof ctx.tools.resolve !== 'function') return available
  let client
  try { client = await import('@deepseek-ai/dsh-mcp-client') }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') ctx.logger.warn('Guard could not load MCP connection status; using call diagnostics.')
    return available
  }
  if (typeof client.connectionStatusOf !== 'function') return available

  const observed = new Map()
  const owners = new WeakMap()
  const original = service => service?.[symbols.original] ?? service
  function capture(record, status) {
    if (status.state !== 'connected') return
    record.definitions.clear()
    const { fiber } = record
    const name = fiber.config?.serverName
    const tools = fiber.ctx.get('tools')
    if (typeof name !== 'string' || !client.SERVER_NAME_PATTERN?.test(name) ||
        !tools || original(tools) !== original(ctx.tools) || !status.toolCount) return
    const scope = scopeOf(fiber.ctx)
    const parent = scope && scopeParentOf(scope)
    const prefix = 'mcp__' + name + '__'
    const definitions = tools.definitions(scope).filter(definition => definition.name.startsWith(prefix) &&
      (!scope || tools.get(definition.name, parent) !== definition))
    if (definitions.length !== status.toolCount) return
    for (const definition of definitions) {
      record.definitions.add(definition)
      owners.set(definition, record)
    }
  }
  function observe() {
    const active = new Set(ctx.registry.get(client)?.fibers ?? [])
    for (const [fiber, record] of observed) if (!active.has(fiber) || fiber.uid === null) {
      record.stop()
      observed.delete(fiber)
    }
    for (const fiber of active) {
      if (observed.has(fiber) || fiber.uid === null) continue
      const status = client.connectionStatusOf(fiber)
      if (!status) continue
      const record = { fiber, status, definitions: new Set(), stop: status.onChange(value => capture(record, value)) }
      observed.set(fiber, record)
      capture(record, status.current())
    }
  }
  ctx.on('tools/change', observe)
  ctx.effect(() => () => {
    for (const record of observed.values()) record.stop()
    observed.clear()
  }, 'Guard: release MCP connection observers')
  observe()
  return definition => {
    const record = owners.get(definition)
    return !!(record && record.fiber.uid !== null && observed.get(record.fiber) === record &&
      record.definitions.has(definition) && disconnectedStates.has(record.status.current().state))
  }
}
