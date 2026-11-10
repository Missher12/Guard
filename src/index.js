import z from '@deepseek-ai/schemastery'
import { mountWindowsGuard } from './guard.js'
import { mountBatchTools } from './batch.js'

export const name = 'dsh-windows-guard'
export const inject = ['tools', 'agents', 'systemPrompt']
export const Config = z.object({
  denyTools: z.array(z.string()).default([]).description('当前会话中始终屏蔽的工具全名。'),
  probeTimeoutMs: z.number().min(250).max(30000).step(1).default(5000).description('每次只读 shell 探测的最长毫秒数。'),
  compactOutput: z.boolean().default(true).description('精简成功日志和批次回执，保留原始结果与完整状态查询。'),
})
export function apply(ctx, config) {
  if (!['win32', 'darwin'].includes(process.platform)) return
  mountBatchTools(ctx, config)
  return mountWindowsGuard(ctx, config)
}
