import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { databaseUrl, redisUrl } from './environment.js'
import prepareDatabase from './prepare-database.js'

// 与 Playwright 共用专用库保护和迁移；不把故障注入打到日常开发库。
// 传入的额外参数交给 Vitest，支持按文件或用例名观察，无须重复跑全套。
try {
  await prepareDatabase()
  execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL('../../node_modules/vitest/vitest.mjs', import.meta.url)),
      'run',
      '--config',
      'vitest.integration.r16.config.ts',
      ...process.argv.slice(2),
    ],
    {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: databaseUrl,
        REDIS_URL: redisUrl,
        OPENAI_API_KEY: '',
        GITHUB_APP_CLIENT_ID: '',
        GITHUB_APP_CLIENT_SECRET: '',
        GITHUB_APP_CALLBACK_URL: '',
        GITHUB_APP_PRIVATE_KEY_PATH: '',
        GITHUB_WEBHOOK_SECRET: '',
      },
    },
  )
} catch (error) {
  // 保留测试失败的退出码，让 CI 真正变红；不打印可能包含连接信息的异常对象。
  const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined
  console.error('R16 regression failed; check the test output and local infrastructure.')
  process.exitCode = typeof status === 'number' && status !== 0 ? status : 1
}
