import { Pool } from 'pg'

import type { DependencyProbe } from './dependency-probe.js'

export class PostgresReadinessProbe implements DependencyProbe {
  private readonly pool: Pool

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      connectionTimeoutMillis: 1_500,
      idleTimeoutMillis: 10_000,
      max: 2,
    })
  }

  async check() {
    await this.pool.query('SELECT 1')
  }

  async close() {
    await this.pool.end()
  }
}
