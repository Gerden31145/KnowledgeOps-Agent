import { z } from 'zod'
import { entityIdSchema } from '../shared/primitives.js'
import { markdownTargetPathSchema } from './plan.js'

export const noteCitationSchema = z
  .object({
    repositoryId: entityIdSchema,
    commitSha: z.string().regex(/^[a-f0-9]{40}$/),
    path: markdownTargetPathSchema,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    excerpt: z.string(),
    // 对应整份 Evidence.content 的 SHA-256，供后续引用复核。
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .refine((value) => value.endLine >= value.startLine, {
    path: ['endLine'],
    message: 'Invalid line range',
  })

export const criterionResultSchema = z
  .object({
    criterionId: entityIdSchema,
    outcome: z.enum(['PASSED', 'FAILED', 'INSUFFICIENT_EVIDENCE']),
    rationale: z.string().min(1),
    suggestions: z.array(z.string()),
    citations: z.array(noteCitationSchema),
    confidence: z.number().min(0).max(1),
  })
  .strict()

export type NoteCitation = z.infer<typeof noteCitationSchema>
export type CriterionResult = z.infer<typeof criterionResultSchema>
