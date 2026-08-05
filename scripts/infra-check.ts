import { Client as PostgresClient } from 'pg'
import { createClient as createRedisClient } from 'redis'
import { z } from 'zod'

const infrastructureEnvironmentSchema = z.object({
  DATABASE_URL: z.string().url().startsWith('postgresql://'),
  REDIS_URL: z.string().url().startsWith('redis://'),
})

function describeTarget(connectionUrl: string) {
  const url = new URL(connectionUrl)
  return `${url.hostname}:${url.port}`
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function parseVersion(version: string) {
  return version.split('.').map((part) => Number.parseInt(part, 10))
}

function isVersionAtLeast(actual: string, required: string) {
  const actualParts = parseVersion(actual)
  const requiredParts = parseVersion(required)
  const partCount = Math.max(actualParts.length, requiredParts.length)

  for (let index = 0; index < partCount; index += 1) {
    const actualPart = actualParts[index] ?? 0
    const requiredPart = requiredParts[index] ?? 0

    if (actualPart > requiredPart) {
      return true
    }

    if (actualPart < requiredPart) {
      return false
    }
  }

  return true
}

async function checkPostgres(connectionString: string) {
  const client = new PostgresClient({ connectionString, connectionTimeoutMillis: 3_000 })

  try {
    await client.connect()
    const result = await client.query<{ ok: number; version: string; versionNumber: number }>(
      "SELECT 1 AS ok, current_setting('server_version') AS version, current_setting('server_version_num')::integer AS \"versionNumber\"",
    )

    if (result.rows[0]?.ok !== 1) {
      throw new Error('SELECT 1 returned an unexpected result')
    }

    if (result.rows[0].versionNumber < 140_000) {
      throw new Error(`PostgreSQL 14 or newer is required; found ${result.rows[0].version}`)
    }

    console.log(
      `✓ PostgreSQL ${result.rows[0].version} SELECT 1 (${describeTarget(connectionString)})`,
    )
  } finally {
    await client.end().catch(() => undefined)
  }
}

async function checkRedis(connectionUrl: string) {
  const client = createRedisClient({
    url: connectionUrl,
    socket: {
      connectTimeout: 3_000,
      reconnectStrategy: false,
    },
  })

  client.on('error', () => undefined)

  try {
    await client.connect()
    const response = await client.ping()

    if (response !== 'PONG') {
      throw new Error(`PING returned ${response}`)
    }

    const serverInfo = await client.info('server')
    const version = /^redis_version:(.+)$/m.exec(serverInfo)?.[1]?.trim() ?? 'unknown'

    if (version === 'unknown' || !isVersionAtLeast(version, '6.2.0')) {
      throw new Error(`Redis 6.2 or newer is required for BullMQ; found ${version}`)
    }

    console.log(`✓ Redis ${version} PING (${describeTarget(connectionUrl)})`)
  } finally {
    if (client.isOpen) {
      await client.quit().catch(() => client.destroy())
    }
  }
}

async function main() {
  const environment = infrastructureEnvironmentSchema.safeParse(process.env)

  if (!environment.success) {
    const invalidFields = environment.error.issues.map((issue) => issue.path.join('.')).join(', ')
    throw new Error(`Invalid infrastructure environment fields: ${invalidFields}`)
  }

  const checks = await Promise.allSettled([
    checkPostgres(environment.data.DATABASE_URL),
    checkRedis(environment.data.REDIS_URL),
  ])
  const failures = checks.filter((result) => result.status === 'rejected')

  if (failures.length > 0) {
    for (const failure of failures) {
      if (failure.status === 'rejected') {
        console.error(`✗ ${errorMessage(failure.reason)}`)
      }
    }
    throw new Error('Local infrastructure check failed')
  }
}

void main().catch((error: unknown) => {
  console.error(errorMessage(error))
  process.exitCode = 1
})
