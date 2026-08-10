import { z } from 'zod'

import { planGenerationRunStateSchema } from '../domain/plan-generation-run-state.js'
import { entityIdSchema } from '../shared/primitives.js'

export const MODEL_CATALOG_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,99}$/

export const modelCatalogIdSchema = z.string().regex(MODEL_CATALOG_ID_PATTERN)

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

export type StartPlanGenerationInput = z.infer<typeof startPlanGenerationInputSchema>
export type PlanGenerationAcceptedResponse = z.infer<typeof planGenerationAcceptedResponseSchema>
