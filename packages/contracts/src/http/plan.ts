import { z } from 'zod'

import { markdownTargetPathSchema, planStatusSchema } from '../domain/plan.js'
import { taskStateSchema } from '../domain/task-state.js'
import { entityIdSchema, isoDateTimeSchema } from '../shared/primitives.js'

export const confirmPlanResponseSchema = z
  .object({
    planId: entityIdSchema,
    status: planStatusSchema.extract(['ACTIVE']),
    confirmedAt: isoDateTimeSchema,
    readyTaskIds: z.array(entityIdSchema),
  })
  .strict()

export const startTaskInputSchema = z
  .object({
    targetPath: markdownTargetPathSchema.optional(),
  })
  .strict()

export const startTaskResponseSchema = z
  .object({
    taskId: entityIdSchema,
    state: taskStateSchema.extract(['IN_PROGRESS']),
    version: z.number().int().nonnegative(),
    targetPath: markdownTargetPathSchema,
  })
  .strict()

export type ConfirmPlanResponse = z.infer<typeof confirmPlanResponseSchema>
export type StartTaskInput = z.infer<typeof startTaskInputSchema>
export type StartTaskResponse = z.infer<typeof startTaskResponseSchema>
