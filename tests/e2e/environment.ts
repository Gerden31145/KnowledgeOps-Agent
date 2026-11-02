import { existsSync, readFileSync } from 'node:fs'
import { parse } from 'dotenv'

// 只取本地连接配置，不把模型密钥或真实 GitHub 配置传给测试服务。
const envPath = new URL('../../.env', import.meta.url)
const local = existsSync(envPath) ? parse(readFileSync(envPath)) : {}
function localConnection(name: 'DATABASE_URL' | 'REDIS_URL', protocol: string) {
  const value = process.env[name] ?? local[name]
  let url: URL
  try {
    url = new URL(value ?? '')
  } catch {
    throw new Error(`R16 requires a valid local ${name}; check .env`)
  }
  if (url.protocol !== protocol || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    throw new Error(`R16 requires loopback ${name}`)
  return url.href
}
if (process.env.NODE_ENV === 'production') throw new Error('R16 is local-test-only')

// 专用库隔离 API 新建的待办，避免被日常开发 Worker 消费。
export const databaseName = 'knowledgeops_r16_e2e'
const testDatabase = new URL(localConnection('DATABASE_URL', 'postgresql:'))
testDatabase.pathname = `/${databaseName}`
testDatabase.searchParams.delete('schema')
export const databaseUrl = testDatabase.href
export const redisUrl = localConnection('REDIS_URL', 'redis:')
export const webOrigin = 'http://127.0.0.1:4300'
export const apiOrigin = 'http://127.0.0.1:4400'
// 仅供本地合成 Webhook，不读取或覆盖用户 GitHub App 的真实 Secret。
export const webhookSecret = 'r16-synthetic-webhook-secret-local-tests-only'
