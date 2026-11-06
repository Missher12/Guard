// These commands have a native PowerShell alternative. Check availability in the
// actual shell so Git for Windows, aliases and user-installed tools keep working.
const alternatives = new Map([
  ['awk', 'ForEach-Object'], ['chmod', 'Get-Acl / Set-Acl'],
  ['grep', 'Select-String'], ['head', 'Select-Object -First'], ['jq', 'ConvertFrom-Json'],
  ['rg', 'the DSH grep tool or Select-String'],
  ['sed', 'Get-Content -LiteralPath or the file tools'], ['tail', 'Get-Content -Tail'],
  ['touch', 'New-Item'], ['which', 'Get-Command'],
])

const pwshProbe = [
  "$dshWinNames = @(Get-Command -Name " + [...alternatives.keys()].join(',') +
    " -ErrorAction SilentlyContinue | ForEach-Object { $_.Name -replace '\\.(exe|cmd|bat|ps1)$','' })",
  "Write-Output ('DSHWIN1:' + $PSVersionTable.PSVersion.Major + ':' + ($dshWinNames -join ','))",
].join('; ')
const bashProbe = 'test -n "$BASH_VERSION" && printf "DSHWIN1:bash\\n"'
const unavailable = Object.freeze({ ready: false })

/** Fixed, read-only commands. Never start our own process or loosen a sandbox. */
export async function probeShell(name, shell, { cwd, sandboxPolicy, signal, timeoutMs = 5000 }) {
  if (!shell) return unavailable
  const deadline = AbortSignal.timeout(timeoutMs)
  const control = signal ? AbortSignal.any([signal, deadline]) : deadline
  let onAbort
  try {
    control.throwIfAborted()
    const spec = shell.resolve({
      command: name === 'pwsh' ? pwshProbe : bashProbe, workdir: cwd,
      sandboxPolicy, timeoutMs, onExpiry: 'kill', signal: control, stdoutMaxBytes: 2048,
    })
    // An executor can stall before it returns its handle, or in result().
    // Forward cancellation to DSH, but do not make the agent depend on
    // a third-party provider settling its promise. Observe late rejections too.
    const cancelled = new Promise(resolve => {
      onAbort = () => resolve(undefined)
      control.addEventListener('abort', onAbort, { once: true })
    })
    if (control.aborted) return unavailable
    const work = Promise.resolve(shell.execute(spec)).then(execution => control.aborted ? undefined : execution.result())
    const result = await Promise.race([work, cancelled])
    if (control.aborted || result.exitCode !== 0 || result.signal || result.timedOut ||
        result.aborted || result.stdout.truncated || result.sandbox?.denied || result.sandbox?.runnerFailed) return unavailable
    const text = result.stdout.text.trim()
    if (name === 'bash') return text === 'DSHWIN1:bash' ? { ready: true } : unavailable
    const marker = /^DSHWIN1:([1-9]\d?):([a-z,]*)$/i.exec(text)
    if (!marker) return unavailable
    const available = new Set(marker[2].toLowerCase().split(',').filter(Boolean))
    for (const cmd of available) if (!alternatives.has(cmd)) return unavailable
    return { ready: true, major: Number(marker[1]), available }
  } catch {
    return unavailable
  } finally {
    if (onAbort) control.removeEventListener('abort', onAbort)
  }
}

// Only inspect simple, single-line PowerShell. More complex scripts belong to
// the host parser. Quotes, escapes, comments and native argument tails matter.
function hasChainOperator(line) {
  if (/[\r\n{}‘’“”]/.test(line) || line.includes('<#') || line.includes('--%')) return false
  let quote = ''
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '`' && quote !== "'") { i++; continue }
    if (quote) {
      if (ch === quote) {
        if (line[i + 1] === quote) i++
        else quote = ''
      }
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '#') break
    else if ((ch === '&' || ch === '|') && line[i + 1] === ch) return true
  }
  return false
}

export function incompatibleCommand(args, facts) {
  const cmd = args?.command
  if (!facts?.ready || typeof cmd !== 'string') return
  if (facts.major < 7 && hasChainOperator(cmd))
    return 'PowerShell ' + facts.major + ': use if ($?) for && and if (-not $?) for ||.'
  if (args.workdir || args.sandbox_permissions || /[\r\n]/.test(cmd)) return
  const head = /^\s*([a-z]+)(?=\s|$)/i.exec(cmd)?.[1].toLowerCase()
  if (alternatives.has(head) && !facts.available.has(head))
    return head + ' is unavailable in this PowerShell session. Use ' + alternatives.get(head) + '.'
}
