import { symbols } from '@deepseek-ai/cordis'
import path from 'node:path'
import { scopeParentOf } from '@deepseek-ai/dsh-scope'
import * as toolApi from '@deepseek-ai/dsh-tools'
import { directoryKey, probeShell, incompatibleCommand, sameDirectory, suggestMissingCommand } from './probe.js'
import { compactShellResult } from './compact.js'

const shells = ['bash', 'pwsh']
const hintVariable = 'dsh_windows_guard_pwsh_hint'
const stockPwshSection = 'Non-zero exits are reported as `[exit code: N]` markers; investigate failures before moving on. ' +
  'On Windows a killed process settles as `[exit code: 1]` without a signal marker; treat a bare exit 1 after an interruption as a termination, not a command failure.'

const original = service => service?.[symbols.original] ?? service

// Persistent PTY and third-party tools can share the shell's name but use a
// different backend. Only the standard DSH shell contracts use this probe.
function usesShellExecutor(definition) {
  const fields = definition?.parameters?.properties
  const prefix = definition?.name === 'pwsh' ? 'Execute a PowerShell command (`pwsh -Command`)' : 'Execute a bash command (`bash -c`)'
  return definition?.description?.startsWith(prefix) && fields?.command?.type === 'string' && fields?.workdir?.type === 'string' &&
    fields?.timeoutMs?.type === 'number' && fields?.description?.type === 'string'
}

// Only a timeout expires. Retry on demand, share the in-flight promise and
// back off for a persistently slow executor without creating any timer.
function startProbe(name, env, signal, timeoutMs, previous, after) {
  const delay = Math.min(60000, previous ? previous.delay * 2 : 5000)
  const probe = { delay, retryAt: Infinity }
  const run = () => probeShell(name, env.shell, { cwd: env.cwd, expectedCwd: env.expectedCwd, sandboxPolicy: env.policy, signal, timeoutMs, platform: env.platform })
  probe.done = (after ? after.then(run) : run()).then(facts => {
    probe.ready = facts.ready
    if (facts.reason === 'timeout') probe.retryAt = performance.now() + delay
    return facts
  })
  return probe
}

function alternateDirectory(args, slot) {
  if (!slot?.facts?.ready || typeof args?.workdir !== 'string' || !args.workdir) return
  const target = path.isAbsolute(args.workdir) ? args.workdir : path.resolve(slot.facts.cwd, args.workdir)
  if (!sameDirectory(target, slot.facts.cwd)) return target
}

function makeRoomForDirectory(slot, now) {
  if (slot.directories.size < 32) return true
  for (const [key, probe] of slot.directories) {
    if (probe.ready) return slot.directories.delete(key)
  }
  // A stream of bad paths must neither starve all future good paths nor
  // continually evict denials. Never evict work in flight or an active timeout.
  if (now >= slot.nextNegativeEviction) {
    for (const [key, probe] of slot.directories) {
      if (probe.ready === false && (probe.retryAt === Infinity || now >= probe.retryAt)) {
        slot.nextNegativeEviction = now + 5000
        return slot.directories.delete(key)
      }
    }
  }
  return false
}

class SessionGuard {
  constructor(ctx, agent, denied, timeoutMs, mutate, monitoredEnvs, platform) {
    this.ctx = ctx
    this.agent = agent
    this.denied = denied
    this.timeoutMs = timeoutMs
    this.mutate = mutate
    this.masks = new Map()
    this.local = new Map()
    this.slots = new Map()
    this.receipts = new WeakMap()
    this.monitoredEnvs = monitoredEnvs
    this.cwdEpoch = 0
    this.closed = false
    this.platform = platform
  }

  noteDirectory(cwd) {
    if (typeof cwd !== 'string') return
    if (this.lastCwd !== undefined && !sameDirectory(this.lastCwd, cwd)) this.cwdEpoch++
    this.lastCwd = cwd
  }

  // restrict() filters inherited definitions. Agent-owned shadows are exempt
  // in DSH; the independent monotonic guard also covers those calls.
  mask(name, definition, needed) {
    if (needed && definition && !this.masks.has(name) && this.local.get(name) !== definition) {
      try {
        // Use the Agent's host-owned context. Its scope identity is correct
        // even when a profile resolves a separate copy of a peer package.
        const lift = this.mutate(() => this.agent.ctx.tools.restrict({ deny: [name] }))
        this.masks.set(name, { lift, definition })
      } catch (error) {
        if (!String(error.message).includes('names unknown global tool')) throw error
        this.local.set(name, definition)
      }
    } else if (!needed && this.masks.has(name)) {
      const { lift } = this.masks.get(name)
      this.masks.delete(name)
      this.mutate(lift)
    }
  }

  environment() {
    const services = this.agent.ctx
    const preset = services.get('agentPresets')
    // serviceFor() can return a sibling's isolated service in a custom preset.
    // Only attest a shell whose executor, directory and policy are unambiguous.
    for (const name of ['shell', 'workingDirectory', 'sandboxPolicy']) {
      const isolated = preset?.serviceFor?.(this.agent, name)
      if (isolated && original(isolated) !== original(services.get(name))) return { independent: true }
    }
    const shell = services.get('shell')
    const cwd = services.get('workingDirectory')?.get(this.agent.session)
    this.noteDirectory(cwd)
    const resolver = services.get('sandboxPolicy')
    const policy = resolver?.resolve({ session: this.agent.session })
    const available = shell && (shell.sandboxMode === undefined || policy)
    return { shell: available ? shell : undefined, identity: available ? original(shell) : undefined, cwd, policy, platform: this.platform,
      key: JSON.stringify([cwd, policy, shell?.pwshPath]) }
  }

  refresh() {
    if (this.closed) return
    const jobs = []
    const tools = this.ctx.tools
    const parent = scopeParentOf(this.agent)
    for (const name of this.denied) this.mask(name, tools.get(name, parent) ?? tools.get(name, this.agent), true)
    for (const name of shells) {
      if (this.denied.has(name)) continue
      const inherited = tools.get(name, parent)
      const masked = this.masks.get(name)
      const definition = tools.get(name, this.agent) ??
        (masked && (parent === undefined ? inherited ?? masked.definition : inherited))
      const old = this.slots.get(name)
      if (!usesShellExecutor(definition)) {
        old?.control?.abort()
        this.slots.delete(name)
        this.mask(name, inherited, false)
        continue
      }
      let env
      try { env = this.environment() } catch { env = { key: 'unavailable' } }
      if (env.independent) {
        old?.control?.abort()
        this.slots.set(name, { definition, independent: true })
        this.mask(name, inherited, false)
        continue
      }
      // Cordis returns a fresh access proxy for the same Service. Compare the
      // underlying service and retain the proxy only for the actual probe.
      const same = old?.definition === definition && !old.independent && old.identity === env.identity && old.key === env.key
      if (same && performance.now() < old.probe.retryAt) {
        jobs.push(old.done)
        continue
      }
      old?.control?.abort()
      const slot = { definition, identity: env.identity, key: env.key, env, control: new AbortController(),
        directories: new Map(), lanes: [undefined, undefined], nextNegativeEviction: 0 }
      this.slots.set(name, slot)
      this.mask(name, definition, true)
      slot.probe = startProbe(name, env, slot.control.signal, this.timeoutMs, same ? old.probe : undefined)
      slot.done = slot.probe.done.then(facts => {
        if (this.closed || this.slots.get(name) !== slot) return
        slot.facts = facts
        if (facts.ready) this.mask(name, inherited, false)
        else this.ctx.logger.info('dsh-windows-guard: ' + name + ' unavailable (' + facts.reason + ') in session ' + this.agent.id)
      })
      jobs.push(slot.done)
    }
    return Promise.all(jobs)
  }

  async checkWorkdir(exec) {
    const slot = this.slots.get('pwsh')
    if (!slot?.facts?.ready) return
    const epoch = this.cwdEpoch
    const cwd = alternateDirectory(exec.arguments, slot)
    if (!cwd) {
      this.receipts.set(exec, { slot, epoch, cwd })
      return
    }
    // Concurrent requests for the same workdir share their probe.
    const key = directoryKey(cwd) ?? cwd
    let probe = slot.directories.get(key)
    if (!probe || performance.now() >= probe.retryAt) {
      if (!probe && !makeRoomForDirectory(slot, performance.now())) {
        this.receipts.set(exec, { slot, epoch, busy: true })
        return
      }
      // Send the stock tool's original spelling to the executor. For a
      // drive-rooted request, compare with the drive of the attested session.
      const expectedCwd = process.platform === 'win32' && /^[\\/](?![\\/])/.test(cwd) ? path.resolve(slot.facts.cwd, cwd) : cwd
      probe = startProbe('pwsh', { ...slot.env, cwd, expectedCwd }, slot.control.signal, this.timeoutMs, probe, slot.lanes.shift())
      slot.directories.set(key, probe)
      slot.lanes.push(probe.done.catch(() => {}))
    }
    const facts = await probe.done
    if (facts.ready) this.receipts.set(exec, { slot, epoch, cwd })
  }

  workdirRefusal(exec) {
    const slot = this.slots.get('pwsh')
    const receipt = this.receipts.get(exec)
    if (!receipt && !slot?.control) return
    if (receipt?.busy) return 'PowerShell directory checks are at capacity. Use a file tool or retry later.'
    if (!receipt || receipt.slot !== slot || receipt.epoch !== this.cwdEpoch ||
        receipt.cwd !== alternateDirectory(exec.arguments, slot))
      return 'pwsh could not verify the requested working directory. Use an available file tool.'
    const services = this.agent.ctx
    const registry = services.get('agentPresets')?.serviceFor?.(this.agent, 'shellEnv') ?? services.get('shellEnv')
    if (!this.monitoredEnvs.has(original(registry)) && directoryKey(exec.arguments?.workdir) === undefined)
      return 'This PowerShell provider requires a fully qualified workdir. Use the absolute workspace path or a file tool.'
  }

  blocked(name) {
    const slot = this.slots.get(name)
    return this.denied.has(name) || (slot && !slot.independent && !slot.facts?.ready)
  }

  matchesBinding(slot, definition) {
    if (slot?.definition !== definition) return false
    try {
      const env = this.environment()
      return env.independent ? !!slot.independent : !slot.independent && slot.identity === env.identity && slot.key === env.key
    } catch { return false }
  }

  filterPresentation(context) {
    // 0.2.2 allows same-scope tool contributions to shadow even a restricted
    // ancestor. Narrow ONLY this assembly's public toolSet input, so both the
    // Native schema provider and PTC renderer see the same candidates. The
    // agent still owns the original selection for dispatch and disposal.
    if (typeof this.ctx.tools.resolve !== 'function') return
    const selected = context.toolSet
    const view = scope => selected ? selected.view(scope) : new Map(
      this.ctx.tools.definitions(scope).map(tool => [tool.name, tool]))
    const hidden = new Set([...view(this.agent).keys()].filter(name => this.blocked(name)))
    if (hidden.size === 0) return
    const filtered = { view: scope => {
      const result = new Map(view(scope))
      if (scope === this.agent) for (const name of hidden) result.delete(name)
      return result
    }, dispose: () => selected?.dispose() }
    const own = Object.hasOwn(context, 'toolSet')
    if (!Reflect.set(context, 'toolSet', filtered)) return
    // Both providers render synchronously from these inputs before the first
    // waterfall await. Restore on failure as well as normal completion.
    queueMicrotask(() => {
      if (context.toolSet !== filtered) return
      if (own) Reflect.set(context, 'toolSet', selected)
      else Reflect.deleteProperty(context, 'toolSet')
    })
  }

  legacySdk(text) {
    // 0.2.1 generates the PTC SDK before the presentation waterfall. Reuse
    // its public renderer, and only replace its unmodified stock output.
    const { tools } = this.ctx
    if (!text || typeof tools.resolve === 'function') return text
    const schemas = tools.schemas(this.agent).filter(tool => tool.name !== 'run_code')
    if (!schemas.some(tool => this.blocked(tool.name))) return text
    const runtime = this.agent.ctx.get('ptcRuntime')
    const render = runtime?.language === 'python' ? toolApi.renderToolsSdkPy :
      runtime?.language === 'typescript' ? toolApi.renderToolsSdk : undefined
    if (!render) return text
    const sdk = schemas.map(tool => ({ ...tool, output: tools.get(tool.name, this.agent).output.schema }))
    if (text !== render(sdk, runtime.programFormat)) return text
    return render(sdk.filter(tool => !this.blocked(tool.name)), runtime.programFormat)
  }

  recheckLaunchError(exec, result) {
    const slot = this.slots.get(exec.name)
    if (!result.isError || !slot?.facts?.ready || exec.signal.aborted || exec.arguments?.sandbox_permissions) return
    const error = result.error
    const launchFailed = error?.info?.code === 'SANDBOX_UNAVAILABLE' ||
      /\bspawn(?:Sync)?\b[^\r\n]*\b(?:ENOENT|EACCES|EPERM)\b/i.test(error?.message ?? '')
    if (!launchFailed) return
    // A missing workdir can also yield ENOENT. Recheck the session executor
    // before masking it, and never replay the original (possibly mutating) call.
    this.slots.delete(exec.name)
    return this.refresh()
  }

  pwshHint() {
    const ps = this.slots.get('pwsh')?.facts
    if (!ps?.ready) return
    const unobserved = ['grep', 'sed', 'awk'].filter(name => !ps.available.has(name))
    const version = ps.major < 7 ? 'PS ' + ps.major + ' lacks &&/||. ' : ''
    const tools = unobserved.length ? (ps.complete ? 'Missing ' + unobserved.join('/') + '. ' : '') + 'Prefer file tools. ' : ''
    const lookup = ps.available.has('which') ? '' : 'Command lookup: Get-Command. '
    return version + tools + lookup + 'Check [exit code: N].' + (this.platform === 'win32' ? ' Interruption can report 1.' : '')
  }

  present(assembly, context) {
    const sections = assembly.sections.flatMap(section => {
      if (section.name === 'tools:sdk') return [{ ...section, text: this.legacySdk(section.text) }]
      if (section.name.startsWith('tool:') && this.denied.has(section.name.slice(5))) return []
      if (shells.some(name => section.name === 'tool:' + name && (this.blocked(name) ||
          (context.toolSet && !context.toolSet.view(this.agent).has(name))))) return []
      if (section.name === 'tool:pwsh' && section.text === stockPwshSection && this.slots.get('pwsh')?.control) {
        const text = assembly.variables[hintVariable]
        return text ? [{ ...section, text }] : []
      }
      const bash = this.slots.get('bash')?.facts
      if (section.name === 'tool:bash' && this.platform === 'darwin' && bash?.ready) {
        const missing = ['rg', 'jq'].filter(name => !bash.available.has(name))
        const hint = ' macOS Bash ' + bash.major + '.' + bash.minor + '. Use command -v for lookup; do not assume GNU sed/date flags.' +
          (bash.major < 4 ? ' Bash 4+ features are unavailable.' : '') +
          (missing.length ? ' Probe did not find ' + missing.join('/') + '; prefer file tools or check availability.' : '')
        return [{ ...section, text: section.text + hint }]
      }
      return [section]
    })
    // On 0.2.2 the provider owns schemas. Both versions apply the registry
    // mask before assembly. 0.2.1 also exposes its final native schema list.
    return { ...assembly, sections, ...(Array.isArray(assembly.tools)
      ? { tools: assembly.tools.filter(tool => !this.blocked(tool.name)) } : {}) }
  }

  async close() {
    this.closed = true
    for (const slot of this.slots.values()) slot.control?.abort()
    for (const { lift } of this.masks.values()) this.mutate(lift)
    this.masks.clear()
    await Promise.allSettled([...this.slots.values()].flatMap(slot => [slot.done, ...(slot.lanes ?? [])]))
  }
}

export function mountWindowsGuard(ctx, config = {}, platform = process.platform) {
  const denied = new Set(config.denyTools ?? [])
  if (denied.has('run_code')) throw new Error('denyTools must name capabilities; run_code is the DSH program transport.')
  const states = new Map()
  const monitoredEnvs = new WeakSet()
  let closed = false
  let scheduled = false
  let mutating = false
  function mutate(action) {
    mutating = true
    try { return action() } finally { mutating = false }
  }
  function attach(agent) {
    if (!states.has(agent)) states.set(agent, new SessionGuard(ctx, agent, denied, config.probeTimeoutMs ?? 5000, mutate, monitoredEnvs, platform))
    return states.get(agent)
  }
  function refreshLater() {
    if (closed || scheduled || mutating) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (!closed) for (const state of states.values()) {
        void Promise.resolve().then(() => state.refresh()).catch(error => ctx.logger.warn(String(error)))
      }
    })
  }
  ctx.on('tools/change', refreshLater)
  ctx.on('agent/created', async ({ agent }) => { await attach(agent).refresh() })
  ctx.on('agent/disposed', ({ agent }) => {
    const state = states.get(agent)
    states.delete(agent)
    return state?.close()
  })
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'sandbox/mode' && event.type !== 'working-directory/change') return
    for (const state of states.values()) if (state.agent.session === session) {
      if (event.type === 'working-directory/change') state.noteDirectory(event.data?.cwd)
      void Promise.resolve(state.refresh()).catch(error => ctx.logger.warn(String(error)))
    }
  })
  const refusal = exec => {
    const state = states.get(exec.agent)
    if (denied.has(exec.name) || state?.blocked(exec.name))
      return exec.name + ' is disabled for this ' + (platform === 'darwin' ? 'macOS' : 'Windows') + ' session. Use another available tool.'
    if (shells.includes(exec.name)) {
      const current = ctx.tools.get(exec.name, exec.agent)
      if (usesShellExecutor(current) && !state?.matchesBinding(state.slots.get(exec.name), current))
        return exec.name + ' has not passed the session shell probe.'
    }
    if (exec.name === 'pwsh') {
      const slot = state?.slots.get('pwsh')
      return state?.workdirRefusal(exec) ?? incompatibleCommand(exec.arguments, slot?.facts)
    }
  }
  ctx.on('tools/pre-execute', async (exec, next) => {
    const state = states.get(exec.agent)
    if (shells.includes(exec.name)) await state?.refresh()
    if (exec.name === 'pwsh') await state?.checkWorkdir(exec)
    const reason = refusal(exec)
    return reason ? { kind: 'deny', reason } : next()
  })
  ctx.tools.guard(refusal)
  // Both stock tools call shellEnv.collect(exec) synchronously after their
  // async workingDirectory.ensure() / approval and before resolving the shell
  // spec or starting a job. This contributor adds no environment variables.
  ctx.inject(['shellEnv'], inner => {
    const registry = inner.get('shellEnv')
    if (typeof registry?.register !== 'function') return
    registry.register({ name: 'dsh-windows-guard-workdir', variables: {}, resolve(exec) {
      if (exec.name === 'pwsh' && states.get(exec.agent)?.receipts.has(exec)) {
        const reason = refusal(exec)
        if (reason) throw new Error(reason)
      }
      return {}
    } })
    const identity = original(registry)
    monitoredEnvs.add(identity)
    inner.effect(() => () => monitoredEnvs.delete(identity))
  })
  // DSH resolves prompt variables before collecting provider-owned schemas.
  // Invalidate a changed shell synchronously here so the collector cannot
  // advertise it while the new probe is pending, even on the first changed step.
  ctx.systemPrompt.variable(hintVariable, context => {
    const state = states.get(context.scope)
    if (!state) return
    state.refresh().catch(error => ctx.logger.warn(String(error)))
    state.filterPresentation(context)
    return state.pwshHint()
  })
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const state = states.get(context.scope)
    if (!state) return next()
    await state.refresh()
    return state.present(await next(), context)
  })
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (decision.kind !== 'accept' || !shells.includes(exec.name)) return decision
    const state = states.get(exec.agent)
    const slot = state?.slots.get(exec.name)
    if (!slot?.control || slot.definition !== ctx.tools.get(exec.name, exec.agent)) return decision
    await state.recheckLaunchError(exec, result)
    if (exec.parent) return decision
    if (exec.name === 'pwsh' && result.value?.exitCode === 1 && !exec.signal.aborted && state.receipts.get(exec)?.slot === slot)
      return suggestMissingCommand(exec.arguments, slot.facts, result, decision)
    return config.compactOutput === false ? decision : compactShellResult(exec.name, result, decision)
  })
  ctx.effect(() => async () => {
    closed = true
    const active = [...states.values()]
    states.clear()
    await Promise.all(active.map(state => state.close()))
  }, 'dsh-windows-guard: release session masks')
  return Promise.all(ctx.agents.list().map(agent => attach(agent).refresh())).then(() => undefined)
}
