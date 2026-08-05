import { LOG_LEVELS } from '@knowledgeops/observability'
import { z } from 'zod'

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
  REDIS_URL: z.string().url().startsWith('redis://').default('redis://127.0.0.1:6379'),
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
