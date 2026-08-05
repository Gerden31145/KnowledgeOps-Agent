import { z } from 'zod'

import { taskStateSchema } from '../domain/task-state.js'
import { entityIdSchema, isoDateTimeSchema } from '../shared/primitives.js'

/** Framework- and presentation-independent snapshot returned by task APIs. */
export const taskDtoSchema = z
  .object({
    id: entityIdSchema,
    stageId: entityIdSchema,
    title: z.string().trim().min(1).max(160),
    state: taskStateSchema,
    position: z.number().int().positive(),
    targetPath: z.string().trim().min(1).max(1_024).nullable(),
    version: z.number().int().nonnegative(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict()

export type TaskDto = z.infer<typeof taskDtoSchema>
