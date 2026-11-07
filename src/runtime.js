import path from 'node:path'
import { fileURLToPath } from 'node:url'

const worker = fileURLToPath(new URL('./batch-worker.py', import.meta.url))
const service = (exec, name) => exec.agent.ctx.get('agentPresets')?.serviceFor?.(exec.agent, name) ?? exec.agent.ctx.get(name)

// Compose through the host pipeline so restrictions, approvals and skill contexts
// remain effective in both Native and PTC. Never invoke a definition's body directly.
async function callTool(ctx, exec, name, args) {
  let result
  const input = { name, arguments: args, agent: exec.agent, signal: exec.signal,
    callId: exec.callId + ':' + name, parent: exec.token, rootCallId: exec.rootCallId, toolSet: exec.toolSet }
  if (typeof ctx.tools.resolve === 'function') {
    const { ToolExecutionPipeline } = await import('@deepseek-ai/dsh-tools/pipeline')
    const pipeline = new ToolExecutionPipeline(ctx)
    const prepared = await pipeline.prepare(input)
    const outcome = prepared.kind === 'dispatch' ? await pipeline.dispatch(prepared.exec) : prepared
    result = await pipeline.complete(prepared.exec, outcome)
  } else result = await ctx.tools.execute(input)
  for (const context of result.additionalContexts ?? []) exec.deferContext?.(context)
  if (result.isError) throw Error(name + ': ' + result.content.map(b => b.text ?? '').join('\n'))
  return result.value
}

async function dependencies(ctx, exec, office, action) {
  const runtime = await callTool(ctx, exec, 'load_workspace_dependencies', {})
  if (!path.isAbsolute(runtime?.python ?? '')) throw Error('宿主未提供 Python 绝对路径，请启用 DSH 办公运行时。')
  if (office && ['export_pdf', 'recalculate'].includes(action)) {
    const result = await callTool(ctx, exec, 'skill', { name: action === 'recalculate' ? 'office-recalculate' : 'office-export-pdf' })
    const strings = []
    function collect(value) {
      if (typeof value === 'string') strings.push(value)
      else if (value && typeof value === 'object') for (const item of Object.values(value)) collect(item)
    }
    collect(result)
    let kit
    for (const text of strings) {
      const start = text.search(/\{\s*"libreofficeKit"\s*:/)
      if (start >= 0) {
        try { kit = JSON.parse(text.slice(start)).libreofficeKit } catch {}
      }
    }
    if (!path.isAbsolute(kit?.cli ?? '') || !path.isAbsolute(kit?.node ?? ''))
      throw Error('宿主办公技能未提供 LibreOffice Kit 路径，请检查办公引擎配置。')
    return { ...runtime, node: kit.node, officeCli: kit.cli }
  }
  return runtime
}

export function createWorkerRunner(ctx) {
  const active = new Set()
  ctx.on('session/event', (session, event) => {
    if (!['sandbox/mode', 'working-directory/change'].includes(event.type)) return
    for (const job of active) if (job.session === session) job.control.abort()
  })
  ctx.effect(() => async () => {
    for (const job of active) job.control.abort()
    await Promise.allSettled([...active].map(job => job.done))
  })
  return async (exec, family, request) => {
    if (!exec.agent?.session) throw Error('批处理需要一个当前会话。')
    const control = new AbortController()
    const job = { control, session: exec.agent.session }
    active.add(job)
    job.done = (async () => {
      const signal = AbortSignal.any([exec.signal, control.signal, AbortSignal.timeout(120000)])
      const scoped = { ...exec, signal }
      const readOnly = ['read', 'inspect', 'list', 'status'].includes(request.action)
      const resolver = service(exec, 'sandboxPolicy')
      let policy = resolver?.resolve({ session: exec.agent.session })
      if (!policy || (!readOnly && policy.mode === 'read-only')) throw Error('当前会话只读或缺少沙箱策略，不能修改文件。')
      let runtime = await dependencies(ctx, scoped, family === 'office', request.action)
      const working = service(exec, 'workingDirectory')
      const root = await working.ensure(exec.agent, signal)
      if (!path.isAbsolute(root ?? '')) throw Error('会话工作目录不可用。')
      const subprocess = service(exec, 'subprocess')
      async function execute() {
        let argv = [runtime.python, '-B', worker]
        const originalPolicy = JSON.stringify(policy)
        if (policy.mode !== 'danger-full-access') {
          const sandbox = service(exec, 'sandbox')
          if (!sandbox) throw Error('当前会话缺少沙箱执行器，不能启动批处理。')
          argv = (await sandbox.confine(argv, policy, signal)).argv
        }
        policy = resolver.resolve({ session: exec.agent.session })
        if (JSON.stringify(policy) !== originalPolicy) throw Error('准备期间权限发生变化，请重新执行。')
        signal.throwIfAborted()
        const payload = JSON.stringify({ root, session: exec.agent.session.id, family, request, runtime })
        if (Buffer.byteLength(payload) > 2 * 1024 * 1024) throw Error('批次请求过大，请分批处理。')
        const child = subprocess.spawn({ argv, cwd: root, signal, graceMs: 1000,
          env: { PYTHONPATH: runtime.pythonPackages, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' },
          stdio: { stdin: { data: payload }, stdout: { maxBytes: 1024 * 1024 }, stderr: { maxBytes: 16000 } } })
        let outcome
        try { outcome = await child.done } finally { await child.waitForExit() }
        const stdout = child.collected.stdout.readFrom(0)
        const stderr = child.collected.stderr.readFrom(0)
        if (signal.aborted || outcome.exitCode !== 0 || outcome.signal || stdout.lossy)
          throw Error('批处理未完整结束。请用 action=list 查看原批次，再按其状态续做；不要重放原操作。' + (stderr.text ? '\n' + stderr.text : ''))
        try { return JSON.parse(stdout.text) } catch { throw Error('批处理没有返回完整结果，请用 action=list 核对原批次。') }
      }
      let result = await execute()
      if (family === 'office' && result.status === 'needs-office-runtime') {
        runtime = await dependencies(ctx, scoped, true, 'export_pdf')
        result = await execute()
      }
      return result
    })()
    try { return await job.done } finally { active.delete(job) }
  }
}
