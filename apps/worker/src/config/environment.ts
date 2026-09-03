import { LOG_LEVELS } from '@knowledgeops/observability'
import { z } from 'zod'

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
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
    OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
    OUTBOX_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
    OUTBOX_RETRY_MAX_DELAY_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(60 * 60 * 1_000)
      .default(60_000),
    REDIS_URL: z.string().url().startsWith('redis://').default('redis://127.0.0.1:6379'),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(2),
  })
  .superRefine((environment, context) => {
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
