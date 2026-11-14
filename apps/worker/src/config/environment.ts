import { LOG_LEVELS } from '@knowledgeops/observability'
import { isAbsolute } from 'node:path'
import { z } from 'zod'

const optionalNonEmptyStringSchema = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().min(1).optional(),
)

const optionalUrlSchema = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().url().optional(),
)

const noteModelSchema = z
  .object({
    catalogId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
    modelName: z.string().trim().min(1).max(160),
    reasoningEffort: z.enum(['low', 'high', 'max']).optional(),
    currency: z.enum(['CNY', 'USD']),
    inputMicrounitsPerMillionTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    outputMicrounitsPerMillionTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
const noteModelConfigurationSchema = z.preprocess((value) => {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}, noteModelSchema.optional())

const workerEnvironmentSchema = z
  .object({
    BULLMQ_JOB_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
    BULLMQ_JOB_BACKOFF_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
    DATABASE_URL: z
      .string()
      .url()
      .startsWith('postgresql://')
      .default('postgresql://knowledgeops:knowledgeops_dev@127.0.0.1:5432/knowledgeops'),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    // GitHub 后台取证按需使用 App 凭据；不需要用户登录 Token 或 Client Secret。
    GITHUB_APP_CLIENT_ID: optionalNonEmptyStringSchema,
    GITHUB_APP_PRIVATE_KEY_PATH: optionalNonEmptyStringSchema.refine(
      (value) => value === undefined || isAbsolute(value),
      { message: 'must be an absolute filesystem path' },
    ),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    OPENAI_API_KEY: optionalNonEmptyStringSchema,
    OPENAI_BASE_URL: optionalUrlSchema,
    // 笔记/追问和回答共用模型目录与额度配置，各 Run 独立冻结；未配置不认领两种验收 Outbox。
    NOTE_VERIFICATION_MODEL_JSON: noteModelConfigurationSchema,
    NOTE_VERIFICATION_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(180_000),
    NOTE_VERIFICATION_MAX_TOTAL_TOKENS: z.coerce.number().int().min(1).max(200_000).default(32_000),
    NOTE_VERIFICATION_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1).max(8_192).default(4_096),
    NOTE_VERIFICATION_MAX_COST_MICROUNITS: z.coerce
      .number()
      .int()
      .min(1)
      .max(100_000_000)
      .default(1_000_000),
    PLAN_GENERATION_OUTPUT_METHOD: z.enum(['jsonSchema', 'jsonMode']).default('jsonSchema'),
    COURSE_QUESTION_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(120_000).default(60_000),
    OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
    OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
    OUTBOX_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
    OUTBOX_RETRY_MAX_DELAY_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(60 * 60 * 1_000)
      .default(60_000),
    PLAN_GENERATION_TIMEOUT_SWEEP_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
    PLAN_GENERATION_TIMEOUT_SWEEP_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(60_000)
      .default(5_000),
    REDIS_URL: z.string().url().startsWith('redis://').default('redis://127.0.0.1:6379'),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(2),
  })
  .superRefine((environment, context) => {
    if (environment.NOTE_VERIFICATION_MODEL_JSON && !environment.OPENAI_API_KEY) {
      context.addIssue({
        code: 'custom',
        message: 'required for note verification',
        path: ['OPENAI_API_KEY'],
      })
    }
    if (environment.OUTBOX_RETRY_BASE_DELAY_MS > environment.OUTBOX_RETRY_MAX_DELAY_MS) {
      context.addIssue({
        code: 'custom',
        message: 'must not be smaller than OUTBOX_RETRY_BASE_DELAY_MS',
        path: ['OUTBOX_RETRY_MAX_DELAY_MS'],
      })
    }
  })

export type WorkerEnvironment = z.infer<typeof workerEnvironmentSchema>

export function readWorkerEnvironment(source: NodeJS.ProcessEnv = process.env): WorkerEnvironment {
  const result = workerEnvironmentSchema.safeParse(source)

  if (!result.success) {
    const invalidFields = result.error.issues.map((issue) => issue.path.join('.')).join(', ')
    throw new Error(`Invalid Worker environment fields: ${invalidFields}`)
  }

  return result.data
}
