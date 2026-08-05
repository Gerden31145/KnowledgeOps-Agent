import { LOG_LEVELS } from '@knowledgeops/observability'
import { z } from 'zod'

const workerEnvironmentSchema = z.object({
  DATABASE_URL: z
    .string()
    .url()
    .startsWith('postgresql://')
    .default('postgresql://knowledgeops:knowledgeops_dev@127.0.0.1:5432/knowledgeops'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  REDIS_URL: z.string().url().startsWith('redis://').default('redis://127.0.0.1:6379'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(2),
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
