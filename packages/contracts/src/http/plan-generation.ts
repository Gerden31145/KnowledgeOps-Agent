import { z } from 'zod'

import { planGenerationRunStateSchema } from '../domain/plan-generation-run-state.js'
import { entityIdSchema, modelCatalogIdSchema } from '../shared/primitives.js'

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

export type StartPlanGenerationInput = z.infer<typeof startPlanGenerationInputSchema>
export type PlanGenerationAcceptedResponse = z.infer<typeof planGenerationAcceptedResponseSchema>
export type PlanGenerationModelOption = z.infer<typeof planGenerationModelOptionSchema>
export type PlanGenerationModelCatalogResponse = z.infer<
  typeof planGenerationModelCatalogResponseSchema
>
