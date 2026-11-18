import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import BashSandbox from '@deepseek-ai/dsh-bash-sandbox'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import { createHost } from './host.js'
import { python } from './worker.js'

export const execute = promisify(execFile)

export async function openBatchFixture(root, { mode = 'workspace-write', config, pluginEntry } = {}) {
  const executable = (await execute(python, ['-c', 'import sys; print(sys.executable)'])).stdout.trim()
  const h = await createHost({ cwd: root, bash: true, nativeEntry: true, sandboxMode: mode, config, pluginEntry,
    async installShell(ctx) {
      await ctx.plugin(Subprocess)
      await ctx.plugin(Sandbox)
      await ctx.plugin(BashSandbox)
    },
  })
  h.ctx.tools.register({ name: 'load_workspace_dependencies', description: 'Test runtime path query',
    parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async () => ({ python: executable }),
  })
  return h
}
