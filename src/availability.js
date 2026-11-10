// Only transport-level diagnostics with a known MCP spelling. A business
// error, timeout or authorization refusal does not establish tool availability.
export function disconnectedMcp(name, result) {
  return /^mcp__/.test(name) && result.isError &&
    /^(?:Not connected|MCP error -32000: Connection closed|MCP error -32000: Not connected)$/.test(result.error?.message ?? '')
}
