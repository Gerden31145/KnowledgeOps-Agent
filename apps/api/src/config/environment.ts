import { modelCatalogIdSchema } from '@knowledgeops/contracts'
import { LOG_LEVELS } from '@knowledgeops/observability'
import { z } from 'zod'

const configuredModelSchema = z
  .object({
    id: modelCatalogIdSchema,
    label: z.string().trim().min(1).max(100).optional(),
    model: z.string().trim().min(1).max(160),
  })
  .strict()

const DEFAULT_CONFIGURED_MODELS_JSON =
  '[{"id":"openai-primary","label":"Fast model","model":"gpt-5.4-mini"}]'

const configuredModelsSchema = z
  .string()
  .default(DEFAULT_CONFIGURED_MODELS_JSON)
  .transform((value, context): unknown => {
    try {
      return JSON.parse(value)
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'must be valid JSON',
      })

      return z.NEVER
    }
  })
  .pipe(z.array(configuredModelSchema).min(1).max(2))
  .superRefine((models, context) => {
    const ids = new Set<string>()

    for (const [index, model] of models.entries()) {
      if (ids.has(model.id)) {
        context.addIssue({
          code: 'custom',
          message: 'model IDs must be unique',
          path: [index, 'id'],
        })
      }

      ids.add(model.id)
    }
  })

const apiEnvironmentSchema = z.object({
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  DATABASE_URL: z
    .string()
    .url()
    .startsWith('postgresql://')
    .default('postgresql://knowledgeops:knowledgeops_dev@127.0.0.1:5432/knowledgeops'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DEVELOPMENT_USER_ID: z.uuid().default('00000000-0000-4000-8000-000000000001'),
  DEVELOPMENT_USER_TIMEZONE: z.string().trim().min(1).default('Asia/Shanghai'),
  PLAN_GENERATION_MODELS_JSON: configuredModelsSchema,
  PLAN_GENERATION_PROVIDER: z.literal('openai').default('openai'),
  PLAN_GENERATION_OUTPUT_SCHEMA_VERSION: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .default('plan-generation-output-v1'),
  PLAN_GENERATION_PROMPT_VERSION: z.string().trim().min(1).max(64).default('plan-generation-v1'),
  PLAN_GENERATION_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(10_000)
    .max(30 * 60 * 1_000)
    .default(3 * 60 * 1_000),
  REDIS_URL: z.string().url().startsWith('redis://').default('redis://127.0.0.1:6379'),
  WEB_ORIGIN: z.string().url().default('http://127.0.0.1:3000'),
})

export type ApiEnvironment = z.infer<typeof apiEnvironmentSchema>

export function readApiEnvironment(source: NodeJS.ProcessEnv = process.env): ApiEnvironment {
  const result = apiEnvironmentSchema.safeParse(source)

  if (!result.success) {
    const invalidFields = result.error.issues.map((issue) => issue.path.join('.')).join(', ')
    throw new Error(`Invalid API environment fields: ${invalidFields}`)
  }

  return result.data
}
