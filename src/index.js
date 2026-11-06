import z from '@deepseek-ai/schemastery'
import { mountWindowsGuard } from './guard.js'

export const name = 'dsh-windows-guard'
export const inject = ['tools', 'agents', 'systemPrompt']
export const Config = z.object({
  denyTools: z.array(z.string()).default([]).description('原生 Windows 上始终屏蔽的工具全名。'),
  probeTimeoutMs: z.number().min(250).max(30000).step(1).default(5000).description('每次只读 shell 探测的最长毫秒数。'),
  compactOutput: z.boolean().default(true).description('折叠成功 shell 输出中的长串连续重复行。'),
})
export function apply(ctx, config) {
  if (process.platform === 'win32') return mountWindowsGuard(ctx, config)
}
