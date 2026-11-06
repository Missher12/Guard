import { Context, Service } from '@deepseek-ai/cordis'
import { bindScopeParent, createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as ToolPwsh from '@deepseek-ai/dsh-tool-pwsh'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import * as WindowsPlugin from '../src/index.js'
import { mountWindowsGuard } from '../src/guard.js'

export const fixtureLog = '检查 [中文 目录] build progress\r\n'.repeat(80) + 'BUILD OK'

// Real Cordis scopes, official shell tools, prompt builder and dispatch
// pipeline. Only the OS boundary and the small fixture workspace are scripted.
export async function createHost({ working = true, bash = false, guard = true, config = {}, installShell,
  installRead, pluginEntry = WindowsPlugin, sandboxMode = 'read-only', presetShell, cwd = process.cwd() } = {}) {
  const ctx = new Context()
  const counts = { probes: 0, commands: 0, reads: 0 }
  const backend = { working, commandError: undefined }
  const agents = []
  const policy = { mode: sandboxMode, workspaceRoot: cwd }
  const shell = {
    sandboxMode: 'read-only',
    resolve(request) { return { workdir: cwd, timeoutMs: 5000, ...request } },
    async execute(spec) {
      const probe = spec.command.includes('DSHWIN1:')
      if (probe) counts.probes++
      else counts.commands++
      if (!backend.working) throw Object.assign(new Error('spawn pwsh.exe ENOENT'), { code: 'ENOENT' })
      if (!probe && backend.commandError) throw backend.commandError
      const psProbe = spec.command.includes('$PSVersionTable')
      const code = probe && !psProbe ? 1 : 0
      const stdout = probe ? (psProbe ? 'DSHWIN1:5:grep\r\n' : '') : fixtureLog
      return { async result() {
        return { exitCode: code, signal: null, timedOut: false, aborted: false, timeoutMs: 5000,
          stdout: { text: stdout, truncated: false }, stderr: { text: '', truncated: false } }
      } }
    },
  }
  ctx.provide('workingDirectory', { get: () => cwd, ensure: async () => cwd })
  ctx.provide('sandboxPolicy', { get defaultMode() { return policy.mode }, resolve: ({ session } = {}) =>
    session ? { ...policy, sessionId: session.id } : policy })
  if (installShell) await installShell(ctx)
  else await ctx.plugin(class FixtureShell extends Service {
    constructor(inner) { super(inner, 'shell'); Object.assign(this, shell) }
  })
  ctx.provide('shellEnv', { collect: () => ({}) })
  if (presetShell) ctx.provide('agentPresets', { serviceFor: (_agent, name) => name === 'shell' ? presetShell : undefined })
  ctx.provide('agents', { list: () => agents })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  const modern = typeof ctx.tools.resolve === 'function'
  if (modern) await ctx.plugin(await import('@deepseek-ai/dsh-tool-executor-native'))

  let owner
  await ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { owner = inner } })
  const preset = {}, presetScope = createScope(owner, preset)
  await presetScope.ctx.plugin(ToolPwsh)
  if (bash) await presetScope.ctx.plugin(ToolBash)
  let sequence = 0
  function register(name, context = presetScope.ctx) {
    return context.tools.register({
      name, description: 'Read the fixture file',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
      async execute() { counts.reads++; return 'answer=42' },
    })
  }
  if (installRead) await installRead(presetScope.ctx)
  else register('read')
  let plugin
  async function enable(options = config) {
    plugin = process.platform === 'win32' ? ctx.plugin(pluginEntry, options)
      : ctx.plugin({ name: 'test-windows-host', inject: ['agents', 'tools', 'systemPrompt'],
          apply(inner) { return mountWindowsGuard(inner, options) } })
    await plugin
  }
  if (guard) await enable()
  async function addAgent(id) {
    const agent = { id, session: { id, header: { cwd } } }
    const scope = createScope(owner, agent)
    agent.ctx = scope.ctx
    bindScopeParent(agent, preset)
    agents.push(agent)
    await ctx.serial(scopeTarget(ctx, agent), 'agent/created', { agent, source: 'new' })
    return agent
  }
  const agent = await addAgent('a')
  const signal = new AbortController().signal
  async function step(scope = agent) {
    const toolSet = modern ? await ctx.tools.resolve({ agent: scope, modelSelection: {}, signal }) : undefined
    try { return await ctx.systemPrompt.assemble({ scope, signal, toolSet }) }
    finally { toolSet?.dispose() }
  }
  async function usePtc(scope = agent) {
    ctx.provide('ptcRuntime', { language: 'typescript', programFormat: 'function-body',
      description: 'Run a short program', run: async () => { throw Error('test only renders the SDK') } })
    if (modern) await scope.ctx.plugin(await import('@deepseek-ai/dsh-tool-executor-ptc'))
    else scope.ctx.tools.presentAs('ptc')
  }
  async function call(name, args = {}, scope = agent) {
    const id = 'c' + sequence++
    if (!modern) return ctx.tools.execute({ name, arguments: args, agent: scope, callId: id, signal })
    const toolSet = await ctx.tools.resolve({ agent: scope, modelSelection: {}, signal })
    try {
      const batch = await ctx.tools.execute({ agent: scope, signal, toolSet,
        calls: [{ type: 'tool-call', name, id, arguments: JSON.stringify(args) }] })
      return batch.results[0].result
    } finally { toolSet.dispose() }
  }
  return { ctx, agent, backend, counts, policy, register, enable, addAgent, step, call, usePtc,
    disable: () => plugin.dispose(), close: () => ctx.fiber.dispose() }
}
