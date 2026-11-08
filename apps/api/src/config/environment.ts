import { modelCatalogIdSchema } from '@knowledgeops/contracts'
import { LOG_LEVELS } from '@knowledgeops/observability'
import { isAbsolute } from 'node:path'
import { z } from 'zod'

const configuredModelSchema = z
  .object({
    id: modelCatalogIdSchema,
    label: z.string().trim().min(1).max(100).optional(),
    model: z.string().trim().min(1).max(160),
    reasoningEffort: z.enum(['low', 'high', 'max']).optional(),
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

const optionalSetting = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().trim().min(1).optional(),
)

const apiEnvironmentSchema = z
  .object({
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
      .default('plan-generation-output-v2'),
    PLAN_GENERATION_PROMPT_VERSION: z.string().trim().min(1).max(64).default('plan-generation-v2'),
    PLAN_GENERATION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(10_000)
      .max(30 * 60 * 1_000)
      .default(3 * 60 * 1_000),
    REDIS_URL: z.string().url().startsWith('redis://').default('redis://127.0.0.1:6379'),
    WEB_ORIGIN: z.string().url().default('http://127.0.0.1:3000'),
    GITHUB_APP_CLIENT_ID: optionalSetting,
    GITHUB_APP_CLIENT_SECRET: optionalSetting,
    // 未配置时仅 Webhook 入口返回 503，不影响已有登录/计划功能。
    GITHUB_WEBHOOK_SECRET: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().min(32).max(256).optional(),
    ),
    // Absolute paths work regardless of whether API starts from the repo or workspace directory.
    // Kept optional while repository integration is being configured; login does not need it.
    GITHUB_APP_PRIVATE_KEY_PATH: optionalSetting.refine(
      (value) => value === undefined || isAbsolute(value),
      { message: 'must be an absolute filesystem path' },
    ),
    GITHUB_APP_CALLBACK_URL: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().url().optional(),
    ),
  })
  .superRefine((environment, context) => {
    // 字段格式校验已生成 issue；不要在错误输入上 new URL 抛出带原值的异常。
    if (
      !z.url().safeParse(environment.WEB_ORIGIN).success ||
      (environment.GITHUB_APP_CALLBACK_URL &&
        !z.url().safeParse(environment.GITHUB_APP_CALLBACK_URL).success)
    )
      return
    const web = new URL(environment.WEB_ORIGIN)
    if (web.origin !== environment.WEB_ORIGIN) {
      context.addIssue({ code: 'custom', path: ['WEB_ORIGIN'], message: 'must be an origin' })
    }
    for (const field of ['WEB_ORIGIN', 'GITHUB_APP_CALLBACK_URL'] as const) {
      const value = environment[field]
      if (!value) continue
      const url = new URL(value)
      const localHttp =
        environment.NODE_ENV !== 'production' &&
        url.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      if (
        (!localHttp && url.protocol !== 'https:') ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: 'requires HTTPS; local HTTP is loopback-only',
        })
      }
    }
    if (environment.GITHUB_APP_CALLBACK_URL) {
      const callback = new URL(environment.GITHUB_APP_CALLBACK_URL)
      // Production may put the API on the dedicated api.<web-host> subdomain.
      // Both remain HTTPS and same-site; cookies stay host-only on the API.
      const dedicatedApi = web.protocol === 'https:' && callback.hostname === `api.${web.hostname}`
      if (
        (callback.hostname !== web.hostname && !dedicatedApi) ||
        callback.protocol !== web.protocol
      ) {
        context.addIssue({
          code: 'custom',
          path: ['GITHUB_APP_CALLBACK_URL'],
          message: 'Web and API must share a scheme and use the same host or its API subdomain',
        })
      }
    }
    if (environment.NODE_ENV === 'production') {
      for (const field of [
        'GITHUB_APP_CLIENT_ID',
        'GITHUB_APP_CLIENT_SECRET',
        'GITHUB_APP_CALLBACK_URL',
      ] as const) {
        if (!environment[field])
          context.addIssue({ code: 'custom', path: [field], message: 'required in production' })
      }
    }
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
