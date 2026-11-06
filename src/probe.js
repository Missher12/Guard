import path from 'node:path'

// Check in the actual shell so Git for Windows, aliases and installed tools
// keep working even when another Windows installation lacks these commands.
const checkedNames = new Set(['awk', 'chmod', 'grep', 'head', 'jq', 'rg', 'sed', 'tail', 'touch', 'which'])

const hexPath = value => "-join $(foreach ($c in [char[]]" + value + ") { '{0:x4}' -f [int]$c })"
const pwshDiscovery = [
  // Set this at the top level of DSH's fresh probe process. A nested script
  // scope or Get-Command -ListImported alone can still import a user's module.
  "$dshWinDiscovery = if ($PSModuleAutoLoadingPreference -in @('None','ModuleQualified')) { 'closed' } else { 'open' }",
  "$PSModuleAutoLoadingPreference = 'None'",
  "$dshWinNames = @(Get-Command -Name " + [...checkedNames].join(',') +
    " -ErrorAction SilentlyContinue | ForEach-Object { $_.Name -replace '\\.(exe|cmd|bat|ps1)$','' })",
  // ASCII UTF-16 code units survive Windows code pages. Basic types and
  // formatting also work in the read-only sandbox's ConstrainedLanguage mode.
  "$dshWinPath = if ($PWD.Provider.Name -ceq 'FileSystem') { " + hexPath('$PWD.ProviderPath') + ' }',
].join('; ')
const pwshMarker = "('DSHWIN1:{0}:{1}:{2}:{3}' -f $PSVersionTable.PSVersion.Major, ($dshWinNames -join ','), $dshWinDiscovery, $dshWinPath)"
const dosComponent = /^(?=[^.]{1,8}(?:\.|$))[^.\\/:*?"<>| ~]+~[1-9]\d*(?:\.[^.\\/:*?"<>| ~]{1,3})?$/

function shortDirectory(value) {
  if (typeof value !== 'string' || !/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/])/i.test(value) ||
      /^[\\/]{2}[?.][\\/]/.test(value)) return
  const spelling = value.replaceAll('/', '\\').replace(/^[a-z]:/i, drive => drive.toUpperCase()).replace(/\\+$/, '')
  if (directoryKey(value) !== spelling) return
  const root = path.win32.parse(spelling).root
  const parts = spelling.slice(root.length).split('\\')
  if (parts.some(part => /[<>:"|?*\u0000-\u001f]|[. ]$/.test(part)) || !parts.some(part => dosComponent.test(part))) return
  return { spelling, root, parts }
}

function pwshProbe(short) {
  if (!short) return pwshDiscovery + '; ' + pwshMarker
  // Send only decimal UTF-16 code units. Even quotes, newlines and PowerShell
  // syntax in a literal path cannot introduce a command into this process.
  const codes = Array.from({ length: short.spelling.length }, (_, i) => short.spelling.charCodeAt(i))
  // Resolve the requested directory in the attested executor, after saving
  // its actual PWD. Import only the system manifest with auto-loading off.
  return [pwshDiscovery, "$dshWinProof = ''", '$dshWinLiteral = -join [char[]](' + codes.join(',') + ')',
    "if ($dshWinPath) { try { $dshWinModule = Microsoft.PowerShell.Core\\Import-Module ($PSHOME + '\\Modules\\Microsoft.PowerShell.Management\\Microsoft.PowerShell.Management.psd1') -PassThru -ErrorAction Stop; " +
    "$dshWinItem = & ($dshWinModule.ExportedCmdlets['Get-Item']) -LiteralPath $dshWinLiteral -Force -ErrorAction Stop; " +
    "if ($dshWinItem.PSIsContainer -and ((" + hexPath('$dshWinItem.FullName') + ") -ceq $dshWinPath)) { $dshWinProof = ':short' } } catch {} }",
    pwshMarker + ' + $dshWinProof'].join('; ')
}

function matchesShortDirectory(short, actual) {
  const cwd = directoryKey(actual)
  if (!short || !cwd?.startsWith(short.root)) return false
  const parts = cwd.slice(short.root.length).split('\\')
  return parts.length === short.parts.length && short.parts.every((value, i) => value === parts[i] || dosComponent.test(value))
}
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
    const short = name === 'pwsh' ? shortDirectory(expectedCwd) : undefined
    // Expanded components can be much longer than their 8.3 spelling. Keep the
    // usual small limit elsewhere and cap alias output at a Win32 path's length.
    const pathLimit = short ? 32767 : expectedCwd?.length ?? 0
    const spec = shell.resolve({
      command: name === 'pwsh' ? pwshProbe(short) : bashProbe, workdir: cwd,
      sandboxPolicy, timeoutMs, onExpiry: 'kill', signal: control, stdoutMaxBytes: Math.max(2048, 4 * pathLimit + 256),
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
    const marker = /^DSHWIN1:([1-9]\d?):([a-z,]*):(open|closed):((?:[a-f0-9]{4})*)(:short)?$/i.exec(text)
    if (!marker || (marker[5] && !short)) return failure('dialect')
    const actual = Buffer.from(marker[4], 'hex').swap16().toString('utf16le')
    let attested = actual
    if (!sameDirectory(expectedCwd ?? spec.workdir, actual)) {
      if (!marker[5] || !matchesShortDirectory(short, actual)) return failure('directory')
      // DSH resolves relative workdirs against the session's original spelling.
      // Its expanded form can contain wildcards that PS5 would resolve differently.
      attested = short.spelling
    }
    const available = new Set(marker[2].toLowerCase().split(',').filter(Boolean))
    for (const cmd of available) if (!checkedNames.has(cmd)) return failure('dialect')
    return { ready: true, major: Number(marker[1]), available, complete: marker[3] === 'closed', cwd: attested }
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

function commandHead(command) {
  return /^\s*([a-z]+)(?=\s|$)/i.exec(command)?.[1].toLowerCase()
}

// Recognize just these literal operations. An unknown command's name alone
// does not tell us its requested behavior (e.g. jq -n or rg --files -g).
function nativeAlternative(command, head) {
  if (!head || /[\r\n‘’“”]/.test(command)) return
  const args = command.trim().slice(head.length).trim()
  if (head === 'rg' && args === '--files') return 'Get-ChildItem -File -Recurse -Name'
  if (head === 'which') {
    const name = /^(['"]?)([a-z\d_][\w.+-]*)\1$/i.exec(args)?.[2]
    if (name && name.toLowerCase() !== 'version') return 'Get-Command'
  }
  if (head === 'jq') {
    const identity = /^(?:\.|'\.'|"\.")[ \t]+(?:(['"])([^'"\x60$]+)\1|([\p{L}\p{N}_.:/\\][\p{L}\p{N}_.:/\\-]*))$/u.exec(args)
    const file = identity?.[2] ?? identity?.[3]
    if (file && !file.startsWith('-')) return 'ConvertFrom-Json'
  }
}

export function incompatibleCommand(args, facts) {
  const cmd = args?.command
  if (!facts?.ready || typeof cmd !== 'string') return
  if (facts.major < 7 && hasChainOperator(cmd))
    return 'PowerShell ' + facts.major + ': use if ($?) for && and if (-not $?) for ||.'
  if (args.workdir || args.sandbox_permissions || /[\r\n]/.test(cmd)) return
  const head = commandHead(cmd)
  if (facts.complete && checkedNames.has(head) && !facts.available.has(head)) {
    const alternative = nativeAlternative(cmd, head)
    return head + ' is unavailable in this PowerShell session.' + (alternative ? ' Use ' + alternative + '.' : '')
  }
}

// A result hint is advisory. Never cache command absence: later calls can load
// a module, change PATH, or run under another workdir or policy.
export function suggestMissingCommand(args, facts, result, decision) {
  const value = result.value
  if (!facts?.ready || typeof args?.command !== 'string' ||
      args.sandbox_permissions || args.run_in_background ||
      decision.kind !== 'accept' || 'content' in decision || 'value' in decision || result.isError ||
      value?.kind !== 'foreground' || value.exitCode !== 1 || value.signal || value.timedOut || value.aborted ||
      value.stopped || value.sandbox?.denied || value.sandbox?.runnerFailed || value.stdout?.text !== '' ||
      value.stdout.truncated || value.stderr?.truncated || typeof value.stderr?.text !== 'string') return decision
  const head = commandHead(args.command)
  const alternative = nativeAlternative(args.command, head)
  if (!alternative || facts.available.has(head)) return decision
  const stderr = value.stderr.text
  // Windows PowerShell's category and error id survive localized prose. With
  // PS7's concise view, match its known English diagnostic or leave it intact.
  const classic = new RegExp('^' + head + ' *:', 'i').test(stderr) &&
    new RegExp('ObjectNotFound: \\(' + head + ':String\\) \\[\\], CommandNotFoundException[\\r\\n]+\\s*\\+ FullyQualifiedErrorId\\s*: CommandNotFoundException\\s*$', 'i').test(stderr)
  const concise = stderr.trimEnd().replaceAll('\r\n', '\n').toLowerCase() === (head + ": The term '" + head +
    "' is not recognized as a name of a cmdlet, function, script file, or executable program.\n" +
    'Check the spelling of the name, or if a path was included, verify that the path is correct and try again.').toLowerCase()
  if (!classic && !concise) return decision
  const marker = '[exit code: 1]'
  const body = '[stderr]\n' + stderr + (stderr.endsWith('\n') ? '' : '\n')
  const block = result.content?.[0]
  if (result.content?.length !== 1 || block?.type !== 'text' || block.text !== body + marker) return decision
  return { ...decision, content: [{ ...block, text: body + 'Try ' + alternative + '.\n' + marker }] }
}
