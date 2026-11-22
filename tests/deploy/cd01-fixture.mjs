// Feed this file to `node --input-type=module - seed|check [runId]` in the Worker image.
// No application source is mounted; imports resolve against the actual production bundle.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import {
  PLAN_GENERATION_OUTPUT_SCHEMA_VERSION,
  PLAN_GENERATION_PROMPT_VERSION,
} from '@knowledgeops/agent-core'
import { createDatabaseClient } from '@knowledgeops/database'

const url = new URL(process.env.DATABASE_URL)
assert.equal(url.hostname, 'postgres', 'Only the isolated Compose database is allowed')
assert.equal(
  url.pathname,
  '/knowledgeops_cd01',
  'Refusing to use a development/production database',
)
assert.equal(url.username, 'cd01')
assert.equal(
  process.env.OPENAI_BASE_URL,
  'http://model:4100/v1',
  'Only the local model fixture is allowed',
)

const database = createDatabaseClient(url.toString())
try {
  const action = process.argv[2]
  if (action === 'seed') {
    const userId = randomUUID(),
      goalId = randomUUID(),
      runId = randomUUID()
    const now = new Date()
    await database.$transaction(async (tx) => {
      await tx.user.create({
        data: { id: userId, githubLogin: 'cd01-synthetic-user', timezone: 'UTC' },
      })
      await tx.learningGoal.create({
        data: {
          id: goalId,
          userId,
          title: 'Learn Docker application deployment',
          currentLevel: 'I understand Vue and want to learn Docker application deployment.',
          deadline: new Date(now.getTime() + 14 * 86_400_000),
          weeklyMinutes: 600,
        },
      })
      await tx.planGenerationRun.create({
        data: {
          id: runId,
          goalId,
          modelCatalogId: 'cd01-model',
          modelProvider: 'openai',
          modelName: 'cd01-fake',
          promptVersion: PLAN_GENERATION_PROMPT_VERSION,
          outputSchemaVersion: PLAN_GENERATION_OUTPUT_SCHEMA_VERSION,
          queuedAt: now,
          deadlineAt: new Date(now.getTime() + 10 * 60_000),
        },
      })
      await tx.outboxEvent.create({
        data: {
          type: 'PLAN_GENERATION_REQUESTED',
          aggregateId: runId,
          deduplicationKey: `plan-generation-requested-${runId}`,
          payload: { generationRunId: runId },
        },
      })
    })
    console.log(JSON.stringify({ event: 'cd01-seeded', runId, goalId, userId }))
  } else if (action === 'check') {
    const runId = process.argv[3]
    assert.match(runId ?? '', /^[a-f\d-]{36}$/i, 'Pass the exact runId printed by seed')
    const until = Date.now() + 30_000
    let run
    do {
      run = await database.planGenerationRun.findFirst({
        where: { id: runId, goal: { user: { githubLogin: 'cd01-synthetic-user' } } },
        include: { plan: { include: { stages: { include: { tasks: true } } } } },
      })
      assert.ok(run, 'The selected synthetic Run must exist')
      if (run.status !== 'QUEUED' && run.status !== 'RUNNING') break
      await setTimeout(500)
    } while (Date.now() < until)
    assert.equal(run.status, 'SUCCEEDED', `Run did not succeed: ${run.errorCode ?? run.status}`)
    assert.ok(run.plan)
    assert.equal(run.plan.stages.flatMap((stage) => stage.tasks).length, 3)
    assert.equal(await database.plan.count({ where: { generationRunId: runId } }), 1)
    const outbox = await database.outboxEvent.findUnique({
      where: { deduplicationKey: `plan-generation-requested-${runId}` },
    })
    assert.ok(outbox?.dispatchedAt, 'The Outbox must have been dispatched')
    const model = await fetch('http://model:4100/health', {
      signal: AbortSignal.timeout(3000),
    }).then((r) => r.json())
    assert.ok(model.calls >= 1, 'The real Worker must have reached the model fixture')
    console.log(
      JSON.stringify({
        event: 'cd01-verified',
        runId,
        status: run.status,
        planId: run.plan.id,
        tasks: 3,
      }),
    )
  } else {
    throw new Error('Usage: node --input-type=module - seed|check [runId]')
  }
} finally {
  await database.$disconnect()
}
