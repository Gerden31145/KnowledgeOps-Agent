import { z } from 'zod'
import { planTaskAcceptanceCriterionTypeSchema } from './plan.js'

export const sectionPresentConfigSchema = z
  .object({
    heading: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(/^[^\r\n]+$/)
      .describe(
        'Required heading text, without Markdown heading markers; use exact text in the description',
      ),
  })
  .strict()

export const contentMinimumConfigSchema = z
  .object({
    minCharacters: z
      .number()
      .int()
      .min(1)
      .max(10_000)
      .describe(
        'Minimum non-whitespace Unicode code points in prose and code; headings, HTML and link URLs do not count',
      ),
  })
  .strict()

// config 是可执行参数，description 是展示给用户的说明；不能从说明猜参数。
export const generatedAcceptanceCriterionSchema = z
  .object({
    type: planTaskAcceptanceCriterionTypeSchema,
    description: z.string().trim().min(5).max(500),
    required: z.boolean(),
    config: z.union([sectionPresentConfigSchema, contentMinimumConfigSchema]).nullable(),
  })
  .strict()
  .superRefine((criterion, context) => {
    const valid =
      criterion.type === 'SECTION_PRESENT'
        ? sectionPresentConfigSchema.safeParse(criterion.config).success
        : criterion.type === 'CONTENT_MINIMUM'
          ? contentMinimumConfigSchema.safeParse(criterion.config).success
          : criterion.config === null
    if (!valid)
      context.addIssue({
        code: 'custom',
        path: ['config'],
        message:
          'SECTION_PRESENT needs heading; CONTENT_MINIMUM needs minCharacters; other types need null',
      })
  })
