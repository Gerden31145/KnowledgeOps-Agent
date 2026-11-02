import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { databaseName, databaseUrl } from './environment.js'

export default async function prepareDatabase() {
  const client = new pg.Client({ connectionString: databaseUrl })
  try {
    await client.connect()
    const { rows } = await client.query<{ name: string; description: string }>(`
      SELECT datname AS name, shobj_description(oid, 'pg_database') AS description
      FROM pg_database WHERE datname = current_database()
    `)
    if (
      rows[0]?.name !== databaseName ||
      rows[0]?.description !== 'KnowledgeOps R16 E2E synthetic fixtures only'
    )
      throw new Error('R16 requires its dedicated database marker; see docs/local-development.md')
  } finally {
    await client.end()
  }
  // 只部署已有迁移，不 reset、不清空库；后续夹具按本次随机 ID 清理。
  execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL('../../node_modules/prisma/build/index.js', import.meta.url)),
      'migrate',
      'deploy',
    ],
    { env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'inherit' },
  )
}
