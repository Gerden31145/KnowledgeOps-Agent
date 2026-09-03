import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SCHEMA_PATH = new URL('../../prisma/schema.prisma', import.meta.url)
const MIGRATION_PATH = new URL(
  '../../prisma/migrations/20260808130000_stage_2_plan_generation_intake/migration.sql',
  import.meta.url,
)
const OUTBOX_RECOVERY_MIGRATION_PATH = new URL(
  '../../prisma/migrations/20260811170000_outbox_dispatch_recovery/migration.sql',
  import.meta.url,
)

describe('plan generation persistence invariants', () => {
  it('keeps the one-active-run invariant in both Prisma and PostgreSQL', () => {
    const schema = readFileSync(SCHEMA_PATH, 'utf8')
    const migration = readFileSync(MIGRATION_PATH, 'utf8')

    expect(schema).toContain('previewFeatures = ["partialIndexes"]')
    expect(schema).toContain('plan_generation_runs_one_active_per_goal')
    expect(schema).toContain(`'QUEUED'::\\"PlanGenerationRunState\\"`)
    expect(schema).toContain(`'RUNNING'::\\"PlanGenerationRunState\\"`)
    expect(migration).toContain('CREATE UNIQUE INDEX "plan_generation_runs_one_active_per_goal"')
    expect(migration).toContain(`WHERE ("status" IN ('QUEUED', 'RUNNING'))`)
  })

  it('does not introduce credential-shaped persistence fields', () => {
    const schema = readFileSync(SCHEMA_PATH, 'utf8').toLowerCase()
    const migration = readFileSync(MIGRATION_PATH, 'utf8').toLowerCase()

    for (const forbiddenField of ['api_key', 'apikey', 'base_url', 'access_token']) {
      expect(schema).not.toContain(forbiddenField)
      expect(migration).not.toContain(forbiddenField)
    }
  })

  it('keeps retryable and dead-lettered outbox events distinguishable', () => {
    const schema = readFileSync(SCHEMA_PATH, 'utf8')
    const migration = readFileSync(OUTBOX_RECOVERY_MIGRATION_PATH, 'utf8')

    expect(schema).toContain('deadLetteredAt')
    expect(schema).toContain('@@index([dispatchedAt, deadLetteredAt, availableAt])')
    expect(migration).toContain('ADD COLUMN "dead_lettered_at"')
    expect(migration).toContain('"outbox_events_dispatched_at_dead_lettered_at_available_at_idx"')
  })
})
