import { z } from 'zod'

import { modelCatalogIdSchema } from '../shared/primitives.js'

export const planGenerationModelSnapshotSchema = z
  .object({
    catalogId: modelCatalogIdSchema,
    provider: z.string().trim().min(1).max(64),
    modelName: z.string().trim().min(1).max(160),
    promptVersion: z.string().trim().min(1).max(64),
    outputSchemaVersion: z.string().trim().min(1).max(64),
  })
  .strict()

export type PlanGenerationModelSnapshot = z.infer<typeof planGenerationModelSnapshotSchema>
