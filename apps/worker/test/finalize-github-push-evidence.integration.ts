import { createHash, randomInt, randomUUID } from 'node:crypto'
import {
  GITHUB_PUSH_RECEIVED_SCHEMA_VERSION,
  NOTE_VERIFICATION_WORKFLOW_VERSION,
} from '@knowledgeops/contracts'
import { createDatabaseClient, Prisma, type DatabaseClient } from '@knowledgeops/database'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readWorkerEnvironment } from '../src/config/environment.js'
import { finalizeGitHubPushEvidence } from '../src/github/finalize-github-push-evidence.js'
import type { CommitFileEvidence } from '../src/github/read-commit-evidence.js'

// 真实 PostgreSQL；取证输入是合成数据，不访问 GitHub、模型或 Redis。
describe('R06 evidence finalization: atomic PostgreSQL handoff', () => {
  const database = createDatabaseClient(readWorkerEnvironment().DATABASE_URL)
  const userId = randomUUID()
  const otherUserId = randomUUID()
  const goalId = randomUUID()
  const planId = randomUUID()
  const taskId = randomUUID()
  const repositoryId = randomUUID()
  const installationId = String(randomInt(4_000_000_000_000, 5_000_000_000_000))
  const githubRepositoryId = String(randomInt(5_000_000_000_000, 6_000_000_000_000))
  const deliveryIds: string[] = []
  const eventIds: string[] = []
  const targetPath = 'notes/vue.md'
  const content = '# Vue\nfixture-only\n'
  const before = 'a'.repeat(40)
  const after = 'b'.repeat(40)
  const binding = { repositoryId, userId, repositoryVersion: 7 }
  const collected = (change: Partial<CommitFileEvidence> = {}) => ({
    status: 'COLLECTED' as const,
    evidence: {
      githubRepositoryId,
      beforeCommitSha: before,
      afterCommitSha: after,
      targetPath,
      previousPath: null,
      change: 'modified' as const,
      sourceCommitSha: after,
      content,
      contentHash: createHash('sha256').update(content).digest('hex'),
      lineCount: 2,
      diff: '@@ -1 +1,2 @@\n # Vue\n+fixture-only',
      ...change,
    },
  })
  async function intake({ beforeSha = before, afterSha = after, taskVersion = 3 } = {}) {
    const deliveryId = randomUUID()
    const eventId = randomUUID()
    deliveryIds.push(deliveryId)
    eventIds.push(eventId)
    await database.$transaction([
      database.webhookDelivery.create({
        data: {
          id: deliveryId,
          eventType: 'push',
          payloadHash: '0'.repeat(64),
          status: 'ACCEPTED',
          payload: {
            installation: { id: installationId },
            repository: { id: githubRepositoryId },
            ref: 'refs/heads/main',
            before: beforeSha,
            after: afterSha,
            deleted: false,
            forced: false,
          },
        },
      }),
      database.outboxEvent.create({
        data: {
          id: eventId,
          type: 'GITHUB_PUSH_RECEIVED',
          aggregateId: deliveryId,
          deduplicationKey: `github-push-received-${deliveryId}`,
          schemaVersion: GITHUB_PUSH_RECEIVED_SCHEMA_VERSION,
          payload: { deliveryId, binding, task: { taskId, taskVersion, targetPath } },
        },
      }),
    ])
    return { eventId, deliveryId }
  }
  async function cleanup() {
    const runs = await database.agentRun.findMany({ where: { taskId }, select: { id: true } })
    await database.outboxEvent.deleteMany({
      where: {
        OR: [
          { id: { in: eventIds } },
          { type: 'NOTE_VERIFICATION_REQUESTED', aggregateId: { in: runs.map((run) => run.id) } },
        ],
      },
    })
    await database.webhookDelivery.deleteMany({ where: { id: { in: deliveryIds } } })
    await database.agentRun.deleteMany({ where: { taskId } })
    await database.submission.deleteMany({ where: { taskId } })
    eventIds.length = 0
    deliveryIds.length = 0
  }
  const savedTask = () => database.task.findUniqueOrThrow({ where: { id: taskId } })
  const savedDelivery = (id: string) =>
    database.webhookDelivery.findUniqueOrThrow({ where: { id } })
  async function expectNoHandoff() {
    expect(await database.submission.count({ where: { taskId } })).toBe(0)
    expect(await database.agentRun.count({ where: { taskId } })).toBe(0)
    expect(await database.evidence.count({ where: { submission: { taskId } } })).toBe(0)
  }

  beforeAll(async () => {
    await database.user.createMany({ data: [{ id: userId }, { id: otherUserId }] })
    await database.gitHubInstallation.create({
      data: {
        id: installationId,
        accountId: '42',
        accountLogin: 'fixture',
        verifiedAt: new Date(),
      },
    })
    await database.learningGoal.create({
      data: {
        id: goalId,
        userId,
        title: 'fixture',
        currentLevel: 'fixture',
        deadline: new Date('2026-12-01'),
        weeklyMinutes: 120,
        plans: {
          create: {
            id: planId,
            status: 'ACTIVE',
            stages: {
              create: {
                title: 'fixture',
                position: 0,
                tasks: {
                  create: {
                    id: taskId,
                    title: 'fixture',
                    description: 'fixture',
                    position: 0,
                    estimatedMinutes: 30,
                    state: 'IN_PROGRESS',
                    targetPath,
                    version: 3,
                  },
                },
              },
            },
          },
        },
      },
    })
  })
  beforeEach(async () => {
    await cleanup()
    await database.repository.deleteMany({ where: { githubRepositoryId } })
    await database.repository.create({
      data: {
        id: repositoryId,
        userId,
        installationId,
        githubRepositoryId,
        fullName: 'fixture/notes',
        defaultBranch: 'main',
        branch: 'main',
        isPrivate: true,
      },
    })
    await database.user.update({ where: { id: userId }, data: { repositoryVersion: 7 } })
    await database.learningGoal.update({ where: { id: goalId }, data: { userId } })
    await database.plan.update({ where: { id: planId }, data: { status: 'ACTIVE' } })
    await database.task.update({
      where: { id: taskId },
      data: { state: 'IN_PROGRESS', version: 3, targetPath },
    })
  })
  afterAll(async () => {
    try {
      await cleanup()
      await database.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } })
      await database.gitHubInstallation.deleteMany({ where: { id: installationId } })
    } finally {
      await database.$disconnect()
    }
  })

  it.each(['IN_PROGRESS', 'NEEDS_REVISION', 'NEEDS_EVIDENCE'] as const)(
    'saves evidence, a queued run, the next outbox and Task version atomically from %s',
    async (state) => {
      await database.task.update({ where: { id: taskId }, data: { state } })
      const receipt = await intake()
      const result = await finalizeGitHubPushEvidence(database, { ...receipt, result: collected() })
      expect(result.status).toBe('PROCESSED')
      if (result.status !== 'PROCESSED') throw new Error('expected processed result')
      const submission = await database.submission.findUniqueOrThrow({
        where: { id: result.submissionId },
        include: { evidence: true },
      })
      expect(submission).toMatchObject({
        repositoryId,
        taskId,
        targetPath,
        beforeCommitSha: before,
        afterCommitSha: after,
      })
      expect(submission.evidence).toMatchObject({
        content,
        sourceCommitSha: after,
        contentHash: collected().evidence.contentHash,
      })
      const run = await database.agentRun.findUniqueOrThrow({ where: { id: result.runId! } })
      expect(run).toMatchObject({
        taskId,
        submissionId: submission.id,
        status: 'QUEUED',
        taskStateBeforeRun: state,
        expectedTaskVersion: 4,
      })
      expect(await savedTask()).toMatchObject({ state: 'VERIFYING', version: 4 })
      expect(await savedDelivery(receipt.deliveryId)).toMatchObject({
        status: 'PROCESSED',
        agentRunId: run.id,
        submissionId: submission.id,
        processedAt: expect.any(Date),
      })
      const events = await database.outboxEvent.findMany({
        where: { type: 'NOTE_VERIFICATION_REQUESTED', aggregateId: run.id },
      })
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        payload: { runId: run.id, submissionId: submission.id },
        dispatchedAt: null,
      })
    },
  )

  it.each(['same delivery', 'different deliveries'])(
    'deduplicates concurrent completion for %s, including replay after terminal success',
    async (scenario) => {
      const receipt = await intake()
      const receipts =
        scenario === 'same delivery'
          ? [receipt, receipt, receipt]
          : [receipt, await intake(), await intake()]
      const results = await Promise.all(
        receipts.map((item) =>
          finalizeGitHubPushEvidence(database, { ...item, result: collected() }),
        ),
      )
      expect(results[1]).toEqual(results[0])
      expect(results[2]).toEqual(results[0])
      expect(await database.submission.count({ where: { taskId } })).toBe(1)
      expect(await database.agentRun.count({ where: { taskId } })).toBe(1)
      expect(await savedTask()).toMatchObject({ version: 4 })
      await database.task.update({ where: { id: taskId }, data: { state: 'PASSED', version: 5 } })
      await database.agentRun.updateMany({ where: { taskId }, data: { status: 'SUCCEEDED' } })
      expect(
        await finalizeGitHubPushEvidence(database, { ...receipt, result: collected() }),
      ).toEqual(results[0])
      expect(await savedTask()).toMatchObject({ state: 'PASSED', version: 5 })
    },
  )

  it.each([
    'NO_MARKDOWN_CHANGE',
    'TARGET_NOT_CHANGED',
    'TARGET_RENAMED',
    'BINDING_CHANGED',
  ] as const)('persists %s without a verification run or a Task transition', async (reason) => {
    const receipt = await intake()
    expect(
      await finalizeGitHubPushEvidence(database, {
        ...receipt,
        result: { status: 'IGNORED', reason },
      }),
    ).toEqual({ status: 'IGNORED', reason })
    await expectNoHandoff()
    expect(await savedTask()).toMatchObject({ state: 'IN_PROGRESS', version: 3 })
    expect(await savedDelivery(receipt.deliveryId)).toMatchObject({
      status: 'IGNORED',
      ignoreReason: reason,
    })
    expect(await finalizeGitHubPushEvidence(database, { ...receipt, result: collected() })).toEqual(
      { status: 'IGNORED', reason },
    )
  })

  it.each([
    'unbound',
    'binding version',
    'task version',
    'target path',
    'passed task',
    'paused plan',
    'wrong owner',
  ])('rejects a stale %s after evidence was read without writing evidence', async (change) => {
    const receipt = await intake()
    if (change === 'unbound')
      await database.repository.update({ where: { id: repositoryId }, data: { enabled: false } })
    if (change === 'binding version')
      await database.user.update({ where: { id: userId }, data: { repositoryVersion: 8 } })
    if (change === 'task version')
      await database.task.update({ where: { id: taskId }, data: { version: 4 } })
    if (change === 'target path')
      await database.task.update({ where: { id: taskId }, data: { targetPath: 'other.md' } })
    if (change === 'passed task')
      await database.task.update({ where: { id: taskId }, data: { state: 'PASSED' } })
    if (change === 'paused plan')
      await database.plan.update({ where: { id: planId }, data: { status: 'PAUSED' } })
    if (change === 'wrong owner')
      await database.learningGoal.update({ where: { id: goalId }, data: { userId: otherUserId } })
    const original = await savedTask()
    expect(await finalizeGitHubPushEvidence(database, { ...receipt, result: collected() })).toEqual(
      {
        status: 'IGNORED',
        reason: ['unbound', 'binding version'].includes(change)
          ? 'BINDING_CHANGED'
          : 'TASK_CHANGED',
      },
    )
    await expectNoHandoff()
    expect(await savedTask()).toEqual(original)
  })

  it.each([
    { githubRepositoryId: '42' },
    { beforeCommitSha: 'c'.repeat(40) },
    { afterCommitSha: 'c'.repeat(40) },
    { targetPath: 'other.md' },
    { sourceCommitSha: before },
    { contentHash: '0'.repeat(64) },
    { lineCount: 999 },
    { diff: '\0' },
  ])(
    'rejects mismatched evidence %j, leaving the durable intent available for retry',
    async (change) => {
      const receipt = await intake()
      await expect(
        finalizeGitHubPushEvidence(database, { ...receipt, result: collected(change) }),
      ).rejects.toThrow('INVALID_EVIDENCE')
      await expectNoHandoff()
      expect(await savedDelivery(receipt.deliveryId)).toMatchObject({
        status: 'ACCEPTED',
        processedAt: null,
      })
      expect(await savedTask()).toMatchObject({ version: 3, state: 'IN_PROGRESS' })
    },
  )

  it('saves a deletion at before SHA, creates no run, and does not fail the task', async () => {
    const receipt = await intake()
    const result = await finalizeGitHubPushEvidence(database, {
      ...receipt,
      result: collected({ change: 'removed', sourceCommitSha: before }),
    })
    expect(result).toMatchObject({ status: 'PROCESSED', runId: null })
    expect(await database.evidence.findFirst({ where: { submission: { taskId } } })).toMatchObject({
      change: 'removed',
      sourceCommitSha: before,
    })
    expect(await database.agentRun.count({ where: { taskId } })).toBe(0)
    expect(await savedTask()).toMatchObject({ state: 'IN_PROGRESS', version: 4 })
  })

  it.each(['modified', 'removed'] as const)(
    'fences an older running verification when a newer %s result takes effect',
    async (change) => {
      const first = await intake()
      const firstResult = await finalizeGitHubPushEvidence(database, {
        ...first,
        result: collected(),
      })
      expect(firstResult.status).toBe('PROCESSED')
      const nextSha = 'c'.repeat(40)
      const next = await intake({ beforeSha: after, afterSha: nextSha, taskVersion: 4 })
      const result = await finalizeGitHubPushEvidence(database, {
        ...next,
        result: collected({
          change,
          beforeCommitSha: after,
          afterCommitSha: nextSha,
          sourceCommitSha: change === 'removed' ? after : nextSha,
        }),
      })
      expect(result.status).toBe('PROCESSED')
      expect(await savedTask()).toMatchObject({
        state: change === 'removed' ? 'IN_PROGRESS' : 'VERIFYING',
        version: 5,
      })
      if (firstResult.status !== 'PROCESSED') throw new Error('expected first run')
      expect(
        await database.agentRun.findUnique({ where: { id: firstResult.runId! } }),
      ).toMatchObject({ expectedTaskVersion: 4 })
      if (change === 'modified' && result.status === 'PROCESSED') {
        expect(await database.agentRun.findUnique({ where: { id: result.runId! } })).toMatchObject({
          expectedTaskVersion: 5,
          taskStateBeforeRun: 'IN_PROGRESS',
        })
      }
    },
  )

  it('does not let two different commits with the same receipt version both change the task', async () => {
    const first = await intake()
    const nextSha = 'c'.repeat(40)
    const next = await intake({ afterSha: nextSha })
    const results = await Promise.all([
      finalizeGitHubPushEvidence(database, { ...first, result: collected() }),
      finalizeGitHubPushEvidence(database, {
        ...next,
        result: collected({ afterCommitSha: nextSha, sourceCommitSha: nextSha }),
      }),
    ])
    expect(results.map((result) => result.status).sort()).toEqual(['IGNORED', 'PROCESSED'])
    expect(await database.agentRun.count({ where: { taskId } })).toBe(1)
    expect(await savedTask()).toMatchObject({ version: 4 })
  })

  it('rolls back all writes when the verification Outbox fails, then succeeds on retry', async () => {
    const receipt = await intake()
    const broken = database.$extends({
      query: {
        outboxEvent: {
          async create() {
            throw new Error('synthetic-outbox-failure')
          },
        },
      },
    }) as unknown as DatabaseClient
    await expect(
      finalizeGitHubPushEvidence(broken, { ...receipt, result: collected() }),
    ).rejects.toThrow('synthetic-outbox-failure')
    await expectNoHandoff()
    expect(await savedTask()).toMatchObject({ state: 'IN_PROGRESS', version: 3 })
    expect(await savedDelivery(receipt.deliveryId)).toMatchObject({
      status: 'ACCEPTED',
      submissionId: null,
    })
    expect(
      await finalizeGitHubPushEvidence(database, { ...receipt, result: collected() }),
    ).toMatchObject({ status: 'PROCESSED' })
  })

  it('holds User and Delivery locks during the final binding check', async () => {
    const receipt = await intake()
    let observed = false
    const inspected = database.$extends({
      query: {
        repository: {
          async findFirst({ args, query }) {
            for (const lock of [
              Prisma.sql`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE NOWAIT`,
              Prisma.sql`SELECT id FROM webhook_deliveries WHERE id = ${receipt.deliveryId}::uuid FOR UPDATE NOWAIT`,
            ])
              await expect(database.$transaction((tx) => tx.$queryRaw(lock))).rejects.toThrow(
                /could not obtain lock/,
              )
            observed = true
            return query(args)
          },
        },
      },
    }) as unknown as DatabaseClient
    await finalizeGitHubPushEvidence(inspected, { ...receipt, result: collected() })
    expect(observed).toBe(true)
  })

  it('rejects a legacy intent instead of reconstructing its missing task from current state', async () => {
    const receipt = await intake()
    await database.outboxEvent.update({
      where: { id: receipt.eventId },
      data: {
        schemaVersion: 1,
        payload: { deliveryId: receipt.deliveryId, bindings: [binding] },
      },
    })
    await expect(
      finalizeGitHubPushEvidence(database, { ...receipt, result: collected() }),
    ).rejects.toThrow('INVALID_INTAKE')
    await expectNoHandoff()
    expect(await savedTask()).toMatchObject({ state: 'IN_PROGRESS', version: 3 })
  })

  it('enforces the note business key in PostgreSQL even outside the finalizer', async () => {
    const receipt = await intake()
    await finalizeGitHubPushEvidence(database, { ...receipt, result: collected() })
    await expect(
      database.submission.create({
        data: {
          repositoryId,
          taskId,
          taskVersion: 3,
          beforeCommitSha: before,
          afterCommitSha: after,
          targetPath,
          workflowVersion: NOTE_VERIFICATION_WORKFLOW_VERSION,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' })
  })

  it.each([userId, otherUserId])(
    'never redirects old evidence to a new binding owned by %s',
    async (newOwner) => {
      const receipt = await intake()
      await database.repository.update({ where: { id: repositoryId }, data: { enabled: false } })
      await database.user.update({ where: { id: userId }, data: { repositoryVersion: 8 } })
      await database.repository.create({
        data: {
          userId: newOwner,
          installationId,
          githubRepositoryId,
          fullName: 'fixture/notes',
          defaultBranch: 'main',
          branch: 'main',
          isPrivate: true,
        },
      })
      expect(
        await finalizeGitHubPushEvidence(database, { ...receipt, result: collected() }),
      ).toEqual({ status: 'IGNORED', reason: 'BINDING_CHANGED' })
      await expectNoHandoff()
      expect(await savedTask()).toMatchObject({ state: 'IN_PROGRESS', version: 3 })
    },
  )

  it('also rolls back the handoff when the final Delivery update fails', async () => {
    const receipt = await intake()
    const broken = database.$extends({
      query: {
        webhookDelivery: {
          async update() {
            throw new Error('synthetic-delivery-failure')
          },
        },
      },
    }) as unknown as DatabaseClient
    await expect(
      finalizeGitHubPushEvidence(broken, { ...receipt, result: collected() }),
    ).rejects.toThrow('synthetic-delivery-failure')
    await expectNoHandoff()
    expect(await savedTask()).toMatchObject({ state: 'IN_PROGRESS', version: 3 })
    expect(await savedDelivery(receipt.deliveryId)).toMatchObject({
      status: 'ACCEPTED',
      processedAt: null,
    })
    expect(
      await finalizeGitHubPushEvidence(database, { ...receipt, result: collected() }),
    ).toMatchObject({ status: 'PROCESSED' })
  })

  it('refuses to invent a restore state for an inconsistent VERIFYING task', async () => {
    const receipt = await intake()
    await database.task.update({ where: { id: taskId }, data: { state: 'VERIFYING' } })
    await expect(
      finalizeGitHubPushEvidence(database, { ...receipt, result: collected() }),
    ).rejects.toThrow('TASK_STATE_INCONSISTENT')
    await expectNoHandoff()
    expect(await savedDelivery(receipt.deliveryId)).toMatchObject({ status: 'ACCEPTED' })
  })
})
