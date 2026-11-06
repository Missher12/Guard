import path from 'node:path'

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
  // Set this at the top level of DSH's fresh probe process. A nested script
  // scope or Get-Command -ListImported alone can still import a user's module.
  "$dshWinDiscovery = if ($PSModuleAutoLoadingPreference -in @('None','ModuleQualified')) { 'closed' } else { 'open' }",
  "$PSModuleAutoLoadingPreference = 'None'",
  "$dshWinNames = @(Get-Command -Name " + [...alternatives.keys()].join(',') +
    " -ErrorAction SilentlyContinue | ForEach-Object { $_.Name -replace '\\.(exe|cmd|bat|ps1)$','' })",
  // ASCII UTF-16 code units survive Windows code pages. Basic types and
  // formatting also work in the read-only sandbox's ConstrainedLanguage mode.
  "$dshWinPath = if ($PWD.Provider.Name -ceq 'FileSystem') { -join $(foreach ($c in [char[]]$PWD.ProviderPath) { '{0:x4}' -f [int]$c }) }",
  "('DSHWIN1:{0}:{1}:{2}:{3}' -f $PSVersionTable.PSVersion.Major, ($dshWinNames -join ','), $dshWinDiscovery, $dshWinPath)",
].join('; ')
const bashProbe = 'test -n "$BASH_VERSION" && printf "DSHWIN1:bash\\n"'
const failure = reason => ({ ready: false, reason })

// Keep component case: Windows also supports case-sensitive directories.
// Never resolve aliases/junctions on the host outside the session's sandbox.
export function directoryKey(value) {
  if (typeof value !== 'string' || !value) return undefined
  // Extended/device paths have their own Win32 dot/separator semantics.
  if (/^[\\/]{2}[?.][\\/]/.test(value)) return value
  if (/^(?:[a-z]:[\\/]|[\\/]{2})/i.test(value))
    return path.win32.normalize(value).replace(/^[a-z]:/i, drive => drive.toUpperCase()).replace(/\\+$/, '')
  if (process.platform !== 'win32' && value.startsWith('/')) return path.posix.normalize(value).replace(/\/+$/, '') || '/'
}

export function sameDirectory(first, second) {
  const expected = directoryKey(first)
  return expected !== undefined && expected === directoryKey(second)
}

/** Fixed, read-only commands. Never start our own process or loosen a sandbox. */
export async function probeShell(name, shell, { cwd, expectedCwd = cwd, sandboxPolicy, signal, timeoutMs = 5000 }) {
  if (!shell) return failure('no-executor')
  const deadline = AbortSignal.timeout(timeoutMs)
  const control = signal ? AbortSignal.any([signal, deadline]) : deadline
  let onAbort
  try {
    control.throwIfAborted()
    const spec = shell.resolve({
      command: name === 'pwsh' ? pwshProbe : bashProbe, workdir: cwd,
      sandboxPolicy, timeoutMs, onExpiry: 'kill', signal: control, stdoutMaxBytes: Math.max(2048, 4 * (expectedCwd?.length ?? 0) + 256),
    })
    // An executor can stall before it returns its handle, or in result().
    // Forward cancellation to DSH, but do not make the agent depend on
    // a third-party provider settling its promise. Observe late rejections too.
    const cancelled = new Promise(resolve => {
      onAbort = () => resolve(undefined)
      control.addEventListener('abort', onAbort, { once: true })
    })
    if (control.aborted) return failure(signal?.aborted ? 'cancelled' : 'timeout')
    const work = Promise.resolve(shell.execute(spec)).then(execution => control.aborted ? undefined : execution.result())
    const result = await Promise.race([work, cancelled])
    if (signal?.aborted) return failure('cancelled')
    if (result?.sandbox?.denied) return failure('denied')
    if (deadline.aborted || result?.timedOut) return failure('timeout')
    if (!result || result.exitCode !== 0 || result.signal || result.aborted ||
        result.stdout?.truncated || result.sandbox?.runnerFailed) return failure('executor')
    const text = result.stdout.text.trim()
    if (name === 'bash') return text === 'DSHWIN1:bash' ? { ready: true } : failure('dialect')
    const marker = /^DSHWIN1:([1-9]\d?):([a-z,]*):(open|closed):((?:[a-f0-9]{4})*)$/i.exec(text)
    if (!marker) return failure('dialect')
    const actual = Buffer.from(marker[4], 'hex').swap16().toString('utf16le')
    if (!sameDirectory(expectedCwd ?? spec.workdir, actual)) return failure('directory')
    const available = new Set(marker[2].toLowerCase().split(',').filter(Boolean))
    for (const cmd of available) if (!alternatives.has(cmd)) return failure('dialect')
    return { ready: true, major: Number(marker[1]), available, complete: marker[3] === 'closed', cwd: actual }
  } catch (error) {
    if (signal?.aborted) return failure('cancelled')
    if (deadline.aborted || error?.code === 'ETIMEDOUT') return failure('timeout')
    return failure('executor')
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
  if (facts.complete && alternatives.has(head) && !facts.available.has(head))
    return head + ' is unavailable in this PowerShell session. Use ' + alternatives.get(head) + '.'
}
