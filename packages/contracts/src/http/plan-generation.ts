import { z } from 'zod'

import { planStatusSchema } from '../domain/plan.js'
import { planGenerationRunStateSchema } from '../domain/plan-generation-run-state.js'
import { entityIdSchema, isoDateTimeSchema, modelCatalogIdSchema } from '../shared/primitives.js'

export const startPlanGenerationInputSchema = z
  .object({
    modelId: modelCatalogIdSchema,
    retryOfRunId: entityIdSchema.optional(),
  })
  .strict()

export const planGenerationAcceptedResponseSchema = z
  .object({
    generationRunId: entityIdSchema,
    status: planGenerationRunStateSchema.extract(['QUEUED']),
  })
  .strict()

export const planGenerationModelOptionSchema = z
  .object({
    id: modelCatalogIdSchema,
    label: z.string().trim().min(1).max(100),
  })
  .strict()

export const planGenerationModelCatalogResponseSchema = z
  .object({
    models: z.array(planGenerationModelOptionSchema).min(1).max(2),
  })
  .strict()

export const planGenerationRunStatusResponseSchema = z
  .object({
    generationRunId: entityIdSchema,
    goalId: entityIdSchema,
    version: z.number().int().nonnegative(),
    status: planGenerationRunStateSchema,
    queuedAt: isoDateTimeSchema,
    startedAt: isoDateTimeSchema.nullable(),
    finishedAt: isoDateTimeSchema.nullable(),
    error: z
      .object({
        code: z.string().trim().min(1).max(64),
        message: z.string().trim().min(1).max(500),
      })
      .strict()
      .nullable(),
    plan: z
      .object({
        id: entityIdSchema,
        status: planStatusSchema,
      })
      .strict()
      .nullable(),
  })
  .strict()

export type StartPlanGenerationInput = z.infer<typeof startPlanGenerationInputSchema>
export type PlanGenerationAcceptedResponse = z.infer<typeof planGenerationAcceptedResponseSchema>
export type PlanGenerationModelOption = z.infer<typeof planGenerationModelOptionSchema>
export type PlanGenerationModelCatalogResponse = z.infer<
  typeof planGenerationModelCatalogResponseSchema
>
export type PlanGenerationRunStatusResponse = z.infer<typeof planGenerationRunStatusResponseSchema>

// 与 Run 的业务失败分开：这里只描述状态订阅本身失败，不改写 Run.status。
export const planGenerationStreamErrorSchema = z
  .object({
    code: z.enum(['UNAUTHENTICATED', 'RESOURCE_NOT_FOUND', 'STREAM_UNAVAILABLE']),
  })
  .strict()
export type PlanGenerationStreamError = z.infer<typeof planGenerationStreamErrorSchema>
