import { z } from 'zod'

import { modelCatalogIdSchema } from '../shared/primitives.js'

export const planGenerationModelSnapshotSchema = z
  .object({
    catalogId: modelCatalogIdSchema,
    provider: z.string().trim().min(1).max(64),
    modelName: z.string().trim().min(1).max(160),
    // 可选以兼容旧快照；未配置时保留供应商默认值，已冻结的 Run 不追加配置。
    reasoningEffort: z.enum(['low', 'high', 'max']).optional(),
    promptVersion: z.string().trim().min(1).max(64),
    outputSchemaVersion: z.string().trim().min(1).max(64),
  })
  .strict()

export type PlanGenerationModelSnapshot = z.infer<typeof planGenerationModelSnapshotSchema>
