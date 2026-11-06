function foldLines(text) {
  if (text.length < 512) return text
  const lines = text.split(/(?<=\n)/)
  const pieces = []
  for (let start = 0; start < lines.length;) {
    const line = lines[start]
    let end = start + 1
    while (lines[end] === line) end++
    const extra = end - start - 1
    const eol = line.endsWith('\r\n') ? '\r\n' : '\n'
    const marker = '[previous line repeated ' + extra + ' more times]' + eol
    pieces.push(extra >= 3 && extra * line.length > marker.length + 24
      ? line + marker : line.repeat(end - start))
    start = end
  }
  const candidate = pieces.join('')
  if (candidate === text || !text.isWellFormed()) return text
  // Proven for the pinned DeepSeek V4 vocabulary (scripts/verify_v4.py).
  // Byte BPE cannot emit more tokens than the candidate's UTF-8 bytes.
  // An original token covers at most 128 bytes and at most one space-
  // separated group containing something other than NBSP. Either bound
  // on the ENTIRE original block must strictly exceed the candidate ceiling.
  const ceiling = Buffer.byteLength(candidate)
  if (Math.ceil(Buffer.byteLength(text) / 128) > ceiling) return candidate
  let groups = 0
  for (const [group] of text.matchAll(/[^ \t\r\n]+/g))
    if (/[^\u00a0]/u.test(group) && ++groups > ceiling) return candidate
  return text
}

/** Only compact the model-facing rendering of successful native shell calls. */
export function compactShellResult(name, result, decision) {
  if ((name !== 'pwsh' && name !== 'bash') || decision.kind !== 'accept' ||
      'value' in decision || 'content' in decision || result.isError ||
      result.value?.exitCode !== 0 || result.value.timedOut || result.value.aborted ||
      result.value.signal || result.value.stopped || result.value.sandbox?.denied || result.value.sandbox?.runnerFailed) return decision
  let changed = false
  const content = result.content.map(block => {
    if (block.type !== 'text') return block
    const text = foldLines(block.text)
    if (text === block.text) return block
    changed = true
    return { ...block, text }
  })
  return changed ? { ...decision, content } : decision
}
