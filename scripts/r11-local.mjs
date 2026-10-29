import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// R11 人工完整链路观察：复用正式服务，隔离旧数据和旧队列。
// 根 .env 仍由调用命令加载；只在当前进程及子进程中覆盖配置。
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const action = process.argv[2]
const commands = {
  check: ['--import', 'tsx', 'scripts/infra-check.ts'],
  migrate: ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
  start: [
    'node_modules/concurrently/dist/bin/index.js',
    '--kill-others',
    '--names',
    'WEB,API,WORKER',
    'pnpm --filter @knowledgeops/web dev',
    'pnpm --filter @knowledgeops/api start',
    'pnpm --filter @knowledgeops/worker start',
  ],
}

try {
  assert(Object.hasOwn(commands, action), 'Usage: pnpm local:r11 <check|migrate|start>')
  assert(process.env.NODE_ENV !== 'production', 'LOCAL_DEVELOPMENT_ONLY')
  const database = new URL(process.env.DATABASE_URL)
  const redis = new URL(process.env.REDIS_URL)
  for (const url of [database, redis])
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'LOCAL_INFRASTRUCTURE_ONLY')
  assert(database.protocol === 'postgresql:' && redis.protocol === 'redis:', 'INVALID_PROTOCOL')
  assert(database.pathname !== '/knowledgeops_r11_smoke', 'KEEP_ROOT_ENV_ON_ORIGINAL_DATABASE')
  assert(!redis.search, 'REDIS_QUERY_OPTIONS_NOT_SUPPORTED')
  assert(redis.pathname !== '/11', 'KEEP_ROOT_ENV_ON_ORIGINAL_REDIS_DATABASE')
  database.pathname = '/knowledgeops_r11_smoke'
  redis.pathname = '/11'

  const env = {
    ...process.env,
    DATABASE_URL: database.href,
    REDIS_URL: redis.href,
    NODE_ENV: 'development',
    API_HOST: '127.0.0.1',
    API_PORT: '4000',
    WEB_ORIGIN: 'http://127.0.0.1:3000',
    NUXT_PUBLIC_API_BASE_URL: 'http://127.0.0.1:4000',
    GITHUB_APP_CALLBACK_URL: 'http://127.0.0.1:4000/auth/github/callback',
    // 使用用户已确认的 GLM-5.3 普通输入/输出单价；费用为估算，不声称缓存折扣已计入。
    NOTE_VERIFICATION_MODEL_JSON: JSON.stringify({
      catalogId: 'glm-5-3',
      modelName: 'glm-5.3',
      reasoningEffort: 'low',
      currency: 'CNY',
      inputMicrounitsPerMillionTokens: 8_000_000,
      outputMicrounitsPerMillionTokens: 28_000_000,
    }),
    NOTE_VERIFICATION_MAX_TOTAL_TOKENS: '16000',
    NOTE_VERIFICATION_MAX_OUTPUT_TOKENS: '4096',
    NOTE_VERIFICATION_MAX_COST_MICROUNITS: '1000000',
    WORKER_CONCURRENCY: '1',
  }
  if (action === 'start') {
    assert(env.OPENAI_API_KEY && env.OPENAI_BASE_URL, 'MODEL_CONFIGURATION_REQUIRED')
    const endpoint = new URL(env.OPENAI_BASE_URL)
    assert(
      endpoint.protocol === 'https:' && endpoint.hostname === 'open.bigmodel.cn',
      'EXPECTED_GLM_ENDPOINT',
    )
  }
  console.log(
    JSON.stringify({
      event: 'r11-local-environment',
      action,
      database: 'knowledgeops_r11_smoke',
      redisDatabase: 11,
      note: 'start 启用真实模型消费；新建计划、Push 与提交回答可能产生模型费用。',
    }),
  )
  const child = spawn(process.execPath, commands[action], {
    cwd: root,
    env,
    stdio: 'inherit',
  })
  child.on('error', () => {
    console.error('R11_LOCAL_COMMAND_START_FAILED')
    process.exitCode = 1
  })
  child.on('exit', (code) => {
    process.exitCode = code ?? 1
  })
} catch (error) {
  console.error(error instanceof assert.AssertionError ? error.message : 'R11_LOCAL_CONFIG_INVALID')
  process.exitCode = 1
}
