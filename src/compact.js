function foldLines(text) {
  if (text.length < 512) return text
  // Keep each terminator with its line, including an entire CRLF pair.
  const lines = text.split(/(?<=\n)|(?<=\r)(?!\n)/)
  const pieces = []
  for (let start = 0; start < lines.length;) {
    const line = lines[start]
    let folded = false
    // Small repeated blocks cover build/install loops without removing changing
    // progress, warnings or unique diagnostics. Work is bounded by eight lines.
    for (let width = 1; width <= 8 && start + 4 * width <= lines.length; width++) {
      let end = start + width
      blocks: for (; end + width <= lines.length; end += width)
        for (let offset = 0; offset < width; offset++)
          if (lines[start + offset] !== lines[end + offset]) break blocks
      const copies = (end - start) / width
      if (copies < 4) continue
      const block = lines.slice(start, start + width).join('')
      const eol = block.endsWith('\r\n') ? '\r\n' : block.slice(-1)
      const marker = '[previous ' + (width === 1 ? 'line' : width + ' lines') + ' repeated ' + (copies - 1) + ' more times]' + eol
      if ((copies - 1) * block.length <= marker.length + 24) continue
      pieces.push(block + marker)
      start += copies * width
      folded = true
      break
    }
    if (!folded) { pieces.push(line); start++ }
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

/** Compact only uniform, fully successful write receipts, never reads/errors.
 * Canonical values and status queries retain all per-item detail. */
export function renderBatchResult(args, value, enabled = true) {
  const original = JSON.stringify(value)
  const full = () => [{ type: 'text', text: original }]
  if (!enabled || ['read', 'inspect', 'list', 'status'].includes(args.action) || value?.status !== 'completed' ||
      typeof value.id !== 'string' || !Array.isArray(value.items) || value.items.length < 8 ||
      value.counts?.completed !== value.items.length ||
      ['failed', 'pending', 'uncertain', 'skipped'].some(key => value.counts[key] !== 0)) return full()
  const common = JSON.stringify(value.items[0].result)
  if (!value.items.every((item, index) => item.index === index && item.status === 'completed' &&
      typeof item.target === 'string' && JSON.stringify(item.result) === common &&
      Object.keys(item).every(key => ['index', 'status', 'target', 'result'].includes(key)))) return full()
  const { items, ...summary } = value
  const text = JSON.stringify({ ...summary, targets: items.map(item => item.target),
    ...(common === undefined ? {} : { result: items[0].result }), details: { action: 'status', id: value.id } })
  return text.length < original.length * 0.75 ? [{ type: 'text', text }] : full()
}
