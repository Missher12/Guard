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
