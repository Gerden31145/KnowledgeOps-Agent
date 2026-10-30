import { z } from 'zod'
import { agentRunStateSchema } from '../domain/agent-run-state.js'
import { entityIdSchema } from '../shared/primitives.js'

export const cancelVerificationRunInputSchema = z
  .object({ expectedRunVersion: z.number().int().nonnegative() })
  .strict()

// 请求已持久化不等于 Worker 已终止；终态重放直接返回当前结果。
export const cancelVerificationRunResponseSchema = z
  .object({
    runId: entityIdSchema,
    taskId: entityIdSchema,
    status: agentRunStateSchema.exclude(['QUEUED', 'RUNNING']),
    version: z.number().int().nonnegative(),
  })
  .strict()

export type CancelVerificationRunInput = z.infer<typeof cancelVerificationRunInputSchema>
export type CancelVerificationRunResponse = z.infer<typeof cancelVerificationRunResponseSchema>
