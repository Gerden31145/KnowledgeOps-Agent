import 'reflect-metadata'
import { createHmac, randomInt, randomUUID } from 'node:crypto'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import type { Prisma } from '@knowledgeops/database'
import { repositoryEvidenceResponseSchema } from '@knowledgeops/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppModule } from '../src/app.module.js'
import { API_ENVIRONMENT } from '../src/config/config.module.js'
import { readApiEnvironment } from '../src/config/environment.js'
import { DatabaseService } from '../src/database/database.service.js'
import { hashToken, opaqueToken } from '../src/identity/auth-http.js'
import { AuthService } from '../src/identity/auth.service.js'
import { RepositoryEvidenceRetryService } from '../src/repositories/repository-evidence-retry.service.js'

const webhookSecret = 'synthetic-r06-receipt-feedback-secret-only'
const environment = readApiEnvironment({
  ...process.env,
  NODE_ENV: 'test',
  GITHUB_WEBHOOK_SECRET: webhookSecret,
})

describe('R06 evidence status: real PostgreSQL, sessions and HTTP; synthetic intake records', () => {
  const database = new DatabaseService(environment.DATABASE_URL)
  const db = database.client
  const ownerId = randomUUID()
  const otherId = randomUUID()
  const taskId = randomUUID()
  const token = opaqueToken()
  const otherToken = opaqueToken()
  const installationId = String(randomInt(1_000_000_000_000, 2_000_000_000_000))
  const githubRepositoryId = String(Number(installationId) + 1)
  const deliveryIds: string[] = []
  let repositoryId: string
  let app: NestExpressApplication
  let baseUrl: string

  const get = (id = repositoryId, session = token) =>
    fetch(`${baseUrl}/repositories/${id}/evidence-deliveries`, {
      headers: session ? { cookie: `knowledgeops_session=${session}` } : {},
    })
  const read = async (id = repositoryId) => {
    const response = await get(id)
    expect(response.status).toBe(200)
    return repositoryEvidenceResponseSchema.parse(await response.json())
  }
  const retry = (
    id: string,
    expectedAttemptCount = 3,
    session = token,
    origin = environment.WEB_ORIGIN,
    bindingId = repositoryId,
    action = 'retry',
  ) =>
    fetch(`${baseUrl}/repositories/${bindingId}/evidence-deliveries/${id}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin,
        ...(session ? { cookie: `knowledgeops_session=${session}` } : {}),
      },
      body: JSON.stringify({ expectedAttemptCount }),
    })
  const resync = (
    id: string,
    count = 3,
    session = token,
    origin = environment.WEB_ORIGIN,
    bindingId = repositoryId,
  ) => retry(id, count, session, origin, bindingId, 'resync')
  const failed = (code = 'GITHUB_UNAVAILABLE') =>
    seed({
      evidenceAttemptCount: 3,
      evidenceFailedAt: new Date(),
      evidenceLastErrorCode: code,
    })
  const createBinding = (bindingUserId = ownerId) =>
    db.repository.create({
      data: {
        userId: bindingUserId,
        installationId,
        githubRepositoryId,
        fullName: 'fixture-owner/notes',
        defaultBranch: 'main',
        branch: 'main',
        isPrivate: true,
      },
    })
  const createSubmission = () =>
    db.submission.create({
      data: {
        repositoryId,
        taskId,
        taskVersion: 1,
        beforeCommitSha: 'a'.repeat(40),
        afterCommitSha: 'b'.repeat(40),
        targetPath: 'notes/learning.md',
        workflowVersion: 'note-verification-v1',
        evidence: {
          create: {
            change: 'removed',
            sourceCommitSha: 'a'.repeat(40),
            content: '# fixture',
            contentHash: 'a'.repeat(64),
            lineCount: 1,
            diff: '-# fixture',
          },
        },
      },
    })
  const push = () => ({
    installation: { id: installationId },
    repository: { id: githubRepositoryId },
    ref: 'refs/heads/main',
    before: 'a'.repeat(40),
    after: 'b'.repeat(40),
    deleted: false,
    forced: false,
  })
  async function receivePush(body: unknown = push(), id = randomUUID(), eventType = 'push') {
    deliveryIds.push(id)
    const rawBody = JSON.stringify(body)
    const response = await fetch(`${baseUrl}/webhooks/github`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': eventType,
        'x-github-delivery': id,
        'x-hub-signature-256': `sha256=${createHmac('sha256', webhookSecret).update(rawBody).digest('hex')}`,
      },
      body: rawBody,
    })
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ received: true })
    return id
  }
  async function seed(
    delivery: Partial<Prisma.WebhookDeliveryUncheckedCreateInput> = {},
    event: Partial<Prisma.OutboxEventUncheckedCreateInput> | null = {},
  ) {
    const id = randomUUID()
    deliveryIds.push(id)
    const completed =
      delivery.status === 'PROCESSED'
        ? { submissionId: (await createSubmission()).id, processedAt: new Date() }
        : {}
    await db.webhookDelivery.create({
      data: {
        id,
        eventType: 'push',
        payloadHash: 'a'.repeat(64),
        status: 'ACCEPTED',
        receivedRepositoryId: repositoryId,
        payload: push(),
        ...delivery,
        ...completed,
      },
    })
    if (event === null) return id
    await db.outboxEvent.create({
      data: {
        type: 'GITHUB_PUSH_RECEIVED',
        aggregateId: id,
        deduplicationKey: `github-push-received-${id}`,
        schemaVersion: 2,
        // 只读查询夹具：即使另有开发 Worker 运行，也不应认领这些合成通知。
        availableAt: new Date('2099-01-01T00:00:00Z'),
        payload: {
          deliveryId: id,
          binding: { userId: ownerId, repositoryId, repositoryVersion: 1 },
          task: { taskId, taskVersion: 1, targetPath: 'notes/learning.md' },
        },
        ...event,
      },
    })
    return id
  }
  async function cleanIntake() {
    await db.outboxEvent.deleteMany({
      where: {
        aggregateId: { in: deliveryIds },
      },
    })
    await db.webhookDelivery.deleteMany({ where: { id: { in: deliveryIds } } })
    await db.agentRun.deleteMany({ where: { taskId } })
    await db.submission.deleteMany({ where: { taskId } })
    deliveryIds.length = 0
  }

  beforeAll(async () => {
    await db.user.createMany({
      data: [
        { id: ownerId, githubLogin: 'r06-status-owner' },
        { id: otherId, githubLogin: 'r06-status-other' },
      ],
    })
    await db.learningGoal.create({
      data: {
        userId: ownerId,
        title: 'fixture',
        currentLevel: 'fixture',
        deadline: new Date('2026-12-01'),
        weeklyMinutes: 120,
        plans: {
          create: {
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
                    targetPath: 'notes/learning.md',
                  },
                },
              },
            },
          },
        },
      },
    })
    await db.session.createMany({
      data: [
        {
          userId: ownerId,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + 3600_000),
        },
        {
          userId: otherId,
          tokenHash: hashToken(otherToken),
          expiresAt: new Date(Date.now() + 3600_000),
        },
      ],
    })
    await db.gitHubInstallation.create({
      data: {
        id: installationId,
        accountId: installationId,
        accountLogin: 'fixture-owner',
        verifiedAt: new Date(),
      },
    })
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(API_ENVIRONMENT)
      .useValue(environment)
      .overrideProvider(DatabaseService)
      .useValue(database)
      .overrideProvider(RepositoryEvidenceRetryService)
      .useValue(
        new RepositoryEvidenceRetryService(database, () => new Date('2099-01-01T00:00:00Z')),
      )
      .compile()
    app = module.createNestApplication<NestExpressApplication>({ logger: false, rawBody: true })
    app.useBodyParser('json', { limit: '100kb', inflate: false })
    // A local session is sufficient: querying status must never request an upstream credential.
    vi.spyOn(app.get(AuthService), 'requireGitHubToken').mockRejectedValue(
      new Error('must not call GitHub'),
    )
    await app.listen(0, '127.0.0.1')
    baseUrl = await app.getUrl()
  })
  beforeEach(async () => {
    await cleanIntake()
    await db.repository.deleteMany({ where: { userId: { in: [ownerId, otherId] } } })
    repositoryId = (await createBinding()).id
    await db.user.update({ where: { id: ownerId }, data: { repositoryVersion: 1 } })
    await db.task.update({
      where: { id: taskId },
      data: { version: 1, state: 'IN_PROGRESS', targetPath: 'notes/learning.md' },
    })
  })
  afterAll(async () => {
    try {
      await cleanIntake()
      await db.user.deleteMany({ where: { id: { in: [ownerId, otherId] } } })
      await db.gitHubInstallation.deleteMany({ where: { id: installationId } })
    } finally {
      if (app) await app.close()
      else await database.onApplicationShutdown()
    }
  })

  it('requires a session and current ownership, validates IDs and does not require a GitHub token', async () => {
    await seed()
    expect((await get(repositoryId, '')).status).toBe(401)
    expect((await get(repositoryId, otherToken)).status).toBe(404)
    expect((await get(randomUUID())).status).toBe(404)
    expect((await get('not-a-uuid')).status).toBe(400)
    const response = await get()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(app.get(AuthService).requireGitHubToken).not.toHaveBeenCalled()
  })

  it('returns empty history, and excludes notifications from a previous binding of the same GitHub repo', async () => {
    expect((await read()).deliveries).toEqual([])
    await seed()
    const oldId = repositoryId
    await db.repository.update({ where: { id: oldId }, data: { enabled: false } })
    repositoryId = (await createBinding()).id
    expect((await get(oldId)).status).toBe(404)
    expect((await read()).deliveries).toEqual([])
  })

  it('R06 observation: ignored receipt is visible without a task, Outbox or verification run', async () => {
    await db.task.update({ where: { id: taskId }, data: { state: 'READY' } })
    const before = await db.task.findUniqueOrThrow({ where: { id: taskId } })
    const id = await receivePush()
    expect(await db.webhookDelivery.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'NO_CURRENT_TASK',
      receivedRepositoryId: repositoryId,
      evidenceAttemptCount: 0,
      submissionId: null,
      agentRunId: null,
    })
    const item = (await read()).deliveries[0]
    expect(item).toMatchObject({
      deliveryId: id,
      taskId: null,
      targetPath: null,
      status: 'IGNORED',
      attemptCount: 0,
      lastAttemptAt: null,
      canRetry: false,
      canResync: false,
    })
    expect(item?.message).toContain('没有正在进行的笔记任务')
    expect(await db.outboxEvent.count({ where: { aggregateId: id } })).toBe(0)
    expect(await db.submission.count({ where: { taskId } })).toBe(0)
    expect(await db.agentRun.count({ where: { taskId } })).toBe(0)
    expect(await db.task.findUniqueOrThrow({ where: { id: taskId } })).toEqual(before)
    expect((await retry(id, 1)).status).toBe(404)
    expect((await resync(id, 1)).status).toBe(404)

    // 后来开始任务也不能把旧通知变成新待办；必须修改目标文件并产生新的 Push。
    await db.task.update({ where: { id: taskId }, data: { state: 'IN_PROGRESS' } })
    await receivePush(push(), id)
    expect((await read()).deliveries).toEqual([item])
    expect(await db.outboxEvent.count({ where: { aggregateId: id } })).toBe(0)
  })

  it.each([
    ['invalid path', {}, 'INVALID_TARGET_PATH', '有效的 Markdown'],
    ['other branch', { ref: 'refs/heads/other' }, 'BRANCH_NOT_TRACKED', '目标分支'],
    ['tag', { ref: 'refs/tags/v1' }, 'REF_UNSUPPORTED', '不是分支 Push'],
    ['deleted branch', { deleted: true, after: '0'.repeat(40) }, 'BRANCH_DELETED', '分支已删除'],
  ])(
    'shows a safe receipt reason for %s without scheduling',
    async (name, changes, reason, text) => {
      if (name === 'invalid path')
        await db.task.update({ where: { id: taskId }, data: { targetPath: null } })
      const id = await receivePush({ ...push(), ...(changes as object) })
      expect(await db.webhookDelivery.findUniqueOrThrow({ where: { id } })).toMatchObject({
        receivedRepositoryId: repositoryId,
        ignoreReason: reason,
      })
      const item = (await read()).deliveries[0]
      expect(item).toMatchObject({
        deliveryId: id,
        status: 'IGNORED',
        taskId: null,
        targetPath: null,
      })
      expect(item?.message).toContain(text)
      expect(await db.outboxEvent.count({ where: { aggregateId: id } })).toBe(0)
    },
  )

  it.each(['same user', 'another user'] as const)(
    'does not transfer an ignored receipt to a new binding owned by %s, including redelivery',
    async (replacement) => {
      await db.task.update({ where: { id: taskId }, data: { state: 'READY' } })
      const id = await receivePush()
      const oldRepositoryId = repositoryId
      await db.repository.update({ where: { id: oldRepositoryId }, data: { enabled: false } })
      const sameUser = replacement === 'same user'
      repositoryId = (await createBinding(sameUser ? ownerId : otherId)).id
      const session = sameUser ? token : otherToken
      await receivePush(push(), id)
      expect(await db.webhookDelivery.findUniqueOrThrow({ where: { id } })).toMatchObject({
        receivedRepositoryId: oldRepositoryId,
        ignoreReason: 'NO_CURRENT_TASK',
      })
      expect((await get(oldRepositoryId)).status).toBe(404)
      expect(
        repositoryEvidenceResponseSchema.parse(await (await get(repositoryId, session)).json())
          .deliveries,
      ).toEqual([])
      expect((await get(repositoryId, sameUser ? otherToken : token)).status).toBe(404)
      const next = await receivePush()
      const visible = repositoryEvidenceResponseSchema.parse(
        await (await get(repositoryId, session)).json(),
      )
      expect(visible.deliveries.map((item) => item.deliveryId)).toEqual([next])
    },
  )

  it('hides unowned history, unbound notifications, ping and unsafe or inconsistent receipt-only records', async () => {
    const visible = await seed({ status: 'IGNORED', ignoreReason: 'NO_CURRENT_TASK' }, null)
    await seed(
      { status: 'IGNORED', ignoreReason: 'NO_CURRENT_TASK', receivedRepositoryId: null },
      null,
    )
    await seed({ status: 'IGNORED', ignoreReason: 'secret-ignore-marker' }, null)
    await seed({ status: 'IGNORED', ignoreReason: '__proto__' }, null)
    await seed(
      { status: 'IGNORED', ignoreReason: 'NO_CURRENT_TASK', evidenceAttemptCount: 1 },
      null,
    )
    await seed({ status: 'ACCEPTED' }, null)
    await receivePush({}, randomUUID(), 'ping')
    await receivePush({ ...push(), installation: { id: '1' } })
    await receivePush({ ...push(), repository: { id: '999' } })
    const response = await read()
    expect(response.deliveries.map((item) => item.deliveryId)).toEqual([visible])
    expect(JSON.stringify(response)).not.toMatch(/secret-|payload|userId|receivedRepositoryId/)
  })

  it('projects persisted processing states without changing the underlying records', async () => {
    const now = new Date()
    const scenarios = [
      ['PENDING', {}, {}],
      [
        'RETRYING',
        {
          evidenceLastErrorCode: 'GITHUB_UNAVAILABLE',
          evidenceAttemptCount: 1,
          evidenceLastAttemptAt: now,
        },
        {},
      ],
      [
        'FAILED',
        {
          evidenceLastErrorCode: 'GITHUB_UNAVAILABLE',
          evidenceFailedAt: now,
          evidenceAttemptCount: 3,
        },
        {},
      ],
      ['RESYNC_REQUIRED', { evidenceLastErrorCode: 'RESYNC_REQUIRED', evidenceFailedAt: now }, {}],
      ['DISPATCH_FAILED', {}, { deadLetteredAt: now, lastError: 'private upstream detail' }],
      ['IGNORED', { status: 'IGNORED', ignoreReason: 'TARGET_NOT_CHANGED' }, {}],
      ['COLLECTED', { status: 'PROCESSED', evidenceLastErrorCode: 'GITHUB_UNAVAILABLE' }, {}],
    ] as const
    const expected = new Map<string, string>()
    for (const [status, delivery, event] of scenarios)
      expected.set(await seed(delivery, event), status)
    const before = await db.webhookDelivery.findMany({
      where: { id: { in: deliveryIds } },
      orderBy: { id: 'asc' },
    })
    const eventsBefore = await db.outboxEvent.findMany({
      where: { aggregateId: { in: deliveryIds } },
      orderBy: { id: 'asc' },
    })
    const result = await read()
    expect(result.deliveries).toHaveLength(7)
    for (const item of result.deliveries) expect(item.status).toBe(expected.get(item.deliveryId))
    expect(result.deliveries.find((item) => item.status === 'RESYNC_REQUIRED')?.message).toContain(
      '基准',
    )
    expect(result.deliveries.find((item) => item.status === 'IGNORED')?.message).toContain(
      '没有修改',
    )
    expect(
      await db.webhookDelivery.findMany({
        where: { id: { in: deliveryIds } },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(before)
    expect(
      await db.outboxEvent.findMany({
        where: { aggregateId: { in: deliveryIds } },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(eventsBefore)
  })

  it('refreshes an earlier retry into a persisted result, never an invented verification success', async () => {
    const id = await seed({ evidenceLastErrorCode: 'GITHUB_UNAVAILABLE', evidenceAttemptCount: 1 })
    expect((await read()).deliveries[0]?.status).toBe('RETRYING')
    await db.webhookDelivery.update({
      where: { id },
      data: {
        status: 'PROCESSED',
        processedAt: new Date(),
        submissionId: (await createSubmission()).id,
        evidenceLastErrorCode: null,
        evidenceFailedAt: null,
      },
    })
    const item = (await read()).deliveries[0]
    expect(item?.status).toBe('COLLECTED')
    expect(item?.message).toContain('未创建语义验收')
  })

  it('describes a created verification run without claiming its outcome', async () => {
    const id = await seed({ status: 'PROCESSED' })
    const delivery = await db.webhookDelivery.findUniqueOrThrow({ where: { id } })
    const run = await db.agentRun.create({
      data: {
        taskId,
        submissionId: delivery.submissionId,
        kind: 'NOTE_VERIFICATION',
        taskStateBeforeRun: 'IN_PROGRESS',
        workflowVersion: 'note-verification-v1',
      },
    })
    await db.webhookDelivery.update({ where: { id }, data: { agentRunId: run.id } })
    expect((await read()).deliveries[0]?.message).toContain('不代表验收通过')
  })

  it('never exposes raw payloads, internal errors or unknown reason strings', async () => {
    await seed({ evidenceLastErrorCode: 'secret-error-marker', evidenceFailedAt: new Date() })
    await seed(
      { status: 'IGNORED', ignoreReason: 'secret-ignore-marker' },
      { lastError: 'secret-outbox-marker' },
    )
    await seed({ status: 'IGNORED', ignoreReason: '__proto__' })
    const text = JSON.stringify(await read())
    expect(text).not.toMatch(
      /secret-|payloadHash|repositoryVersion|lastError|userId|\[object Object\]/,
    )
    expect(text).toContain('不符合处理条件')
  })

  it('filters original owner, schema version and malformed or mismatched intake instead of guessing context', async () => {
    const valid = await seed()
    const outbox = await db.outboxEvent.findFirstOrThrow({ where: { aggregateId: valid } })
    const context = outbox.payload as Prisma.JsonObject
    await seed(
      {},
      { payload: { ...context, binding: { userId: otherId, repositoryId, repositoryVersion: 1 } } },
    )
    await seed({}, { schemaVersion: 1 })
    await seed({}, { payload: { ...context, deliveryId: randomUUID() } })
    await seed({}, { payload: { ...context, task: {} } })
    await seed({
      payload: {
        installation: { id: installationId },
        repository: { id: githubRepositoryId },
        ref: 'refs/heads/other',
        before: 'a'.repeat(40),
        after: 'b'.repeat(40),
        deleted: false,
        forced: false,
      },
    })
    expect((await read()).deliveries.map((item) => item.deliveryId)).toEqual([valid])
  })

  it('bounds history to the newest 20 frozen notifications', async () => {
    for (let index = 0; index < 23; index++)
      await seed(
        {
          receivedAt: new Date(Date.UTC(2026, 9, 15, 0, index)),
          ...(index % 2 ? { status: 'IGNORED', ignoreReason: 'NO_CURRENT_TASK' } : {}),
        },
        index % 2 ? null : {},
      )
    expect((await read()).deliveries.map((item) => item.deliveryId)).toEqual(
      deliveryIds.slice(3).reverse(),
    )
  })

  it('snapshot resync requires authentication, Origin, ownership and a minimal command', async () => {
    const id = await failed('RESYNC_REQUIRED')
    expect((await resync(id, 3, '')).status).toBe(401)
    expect((await resync(id, 3, token, '')).status).toBe(403)
    expect((await resync(id, 3, token, 'https://untrusted.example')).status).toBe(403)
    expect((await resync(id, 3, otherToken)).status).toBe(404)
    expect((await resync(randomUUID())).status).toBe(404)
    expect((await resync(id, 0)).status).toBe(400)
    expect(
      (
        await fetch(`${baseUrl}/repositories/${repositoryId}/evidence-deliveries/${id}/resync`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: environment.WEB_ORIGIN,
            cookie: `knowledgeops_session=${token}`,
          },
          body: JSON.stringify({ expectedAttemptCount: 3, afterCommitSha: 'c'.repeat(40) }),
        })
      ).status,
    ).toBe(400)
    expect(await db.outboxEvent.count({ where: { aggregateId: id } })).toBe(1)
  })

  it('snapshot resync persists one explicit mode for duplicate clicks and does no upstream work in HTTP', async () => {
    const id = await failed('RESYNC_REQUIRED')
    const original = await db.outboxEvent.findFirstOrThrow({ where: { aggregateId: id } })
    const task = await db.task.findUniqueOrThrow({ where: { id: taskId } })
    expect((await read()).deliveries[0]).toMatchObject({
      status: 'RESYNC_REQUIRED',
      canRetry: false,
      canResync: true,
    })
    expect((await retry(id)).status).toBe(409)
    const responses = await Promise.all([resync(id), resync(id)])
    expect(responses.map((response) => response.status)).toEqual([202, 202])
    const [accepted, duplicate] = await Promise.all(responses.map((response) => response.json()))
    expect(duplicate).toEqual(accepted)
    expect(await (await resync(id)).json()).toEqual(accepted)
    const event = await db.outboxEvent.findUniqueOrThrow({ where: { id: accepted.retryEventId } })
    expect(event).toMatchObject({
      schemaVersion: 2,
      type: 'GITHUB_EVIDENCE_RETRY_REQUESTED',
      payload: {
        sourceEventId: original.id,
        evidenceMode: 'SNAPSHOT',
        previousErrorCode: 'RESYNC_REQUIRED',
        previousAttemptCount: 3,
      },
    })
    expect(await db.outboxEvent.count({ where: { aggregateId: id } })).toBe(2)
    expect(await db.outboxEvent.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original)
    expect(await db.task.findUniqueOrThrow({ where: { id: taskId } })).toEqual(task)
    expect(await db.agentRun.count({ where: { taskId } })).toBe(0)
    expect((await read()).deliveries[0]).toMatchObject({
      status: 'RETRYING',
      canRetry: false,
      canResync: false,
    })
    expect((await read()).deliveries[0]?.message).toContain('全文快照')
    expect(app.get(AuthService).requireGitHubToken).not.toHaveBeenCalled()
  })

  it.each(['GITHUB_UNAVAILABLE', 'LIMIT_EXCEEDED', 'TASK_CHANGED', 'INVALID_EVIDENCE'])(
    'snapshot resync cannot waive an unrelated failure %s',
    async (code) => {
      const id = await failed(code)
      expect((await read()).deliveries[0]?.canResync).toBe(false)
      expect((await resync(id)).status).toBe(409)
      expect(await db.outboxEvent.count({ where: { aggregateId: id } })).toBe(1)
    },
  )

  it('snapshot resync rejects stale counters, in-flight work and a changed original task or binding', async () => {
    const id = await failed('RESYNC_REQUIRED')
    expect((await resync(id, 2)).status).toBe(409)
    await db.webhookDelivery.update({ where: { id }, data: { evidenceFailedAt: null } })
    expect((await resync(id)).status).toBe(409)
    await db.webhookDelivery.update({ where: { id }, data: { evidenceFailedAt: new Date() } })
    await db.task.update({ where: { id: taskId }, data: { version: 2 } })
    expect((await read()).deliveries[0]?.canResync).toBe(false)
    expect((await resync(id)).status).toBe(409)
    await db.task.update({ where: { id: taskId }, data: { version: 1 } })
    await db.user.update({ where: { id: ownerId }, data: { repositoryVersion: 2 } })
    expect((await read()).deliveries[0]?.canResync).toBe(false)
    expect((await resync(id)).status).toBe(409)
    expect(await db.outboxEvent.count({ where: { aggregateId: id } })).toBe(1)
  })

  it('snapshot resync preserves the mode through later ordinary retries without reviving an earlier round', async () => {
    const id = await failed('RESYNC_REQUIRED')
    const first = await (await resync(id)).json()
    await db.webhookDelivery.update({
      where: { id },
      data: {
        evidenceAttemptCount: 4,
        evidenceFailedAt: new Date(),
        evidenceLastErrorCode: 'GITHUB_UNAVAILABLE',
      },
    })
    expect((await read()).deliveries[0]).toMatchObject({
      status: 'FAILED',
      canRetry: true,
      canResync: false,
    })
    const response = await retry(id, 4)
    expect(response.status).toBe(202)
    const second = await response.json()
    expect(
      (await db.outboxEvent.findUniqueOrThrow({ where: { id: second.retryEventId } })).payload,
    ).toMatchObject({
      evidenceMode: 'SNAPSHOT',
      previousErrorCode: 'GITHUB_UNAVAILABLE',
      previousAttemptCount: 4,
    })
    expect(await (await resync(id)).json()).toEqual(first)
    expect(
      (await db.webhookDelivery.findUniqueOrThrow({ where: { id } })).evidenceRetryEventId,
    ).toBe(second.retryEventId)
  })

  it('snapshot resync display uses the saved evidence mode without claiming acceptance has passed', async () => {
    const id = await seed({ status: 'PROCESSED' })
    const delivery = await db.webhookDelivery.findUniqueOrThrow({ where: { id } })
    await db.evidence.update({
      where: { submissionId: delivery.submissionId! },
      data: {
        mode: 'SNAPSHOT',
        change: null,
        diff: null,
        sourceCommitSha: 'b'.repeat(40),
      },
    })
    const run = await db.agentRun.create({
      data: {
        taskId,
        submissionId: delivery.submissionId,
        kind: 'NOTE_VERIFICATION',
        taskStateBeforeRun: 'IN_PROGRESS',
        workflowVersion: 'note-verification-v1',
      },
    })
    await db.webhookDelivery.update({ where: { id }, data: { agentRunId: run.id } })
    const item = (await read()).deliveries[0]
    expect(item).toMatchObject({ status: 'COLLECTED', canRetry: false, canResync: false })
    expect(item?.message).toContain('全文快照')
    expect(item?.message).toContain('不代表验收通过')
  })

  it('manual recovery requires session, Origin, current ownership and a valid command', async () => {
    const id = await failed()
    expect((await retry(id, 3, '')).status).toBe(401)
    expect((await retry(id, 3, token, '')).status).toBe(403)
    expect((await retry(id, 3, token, 'https://untrusted.example')).status).toBe(403)
    expect((await retry(id, 3, otherToken)).status).toBe(404)
    expect((await retry(randomUUID())).status).toBe(404)
    expect((await retry(id, 0)).status).toBe(400)
    expect((await retry('bad-id')).status).toBe(400)
    expect(
      await db.outboxEvent.count({
        where: { aggregateId: id, type: 'GITHUB_EVIDENCE_RETRY_REQUESTED' },
      }),
    ).toBe(0)
  })

  it('manual recovery atomically records one durable request for concurrent/replayed clicks', async () => {
    const id = await failed()
    const original = await db.outboxEvent.findFirstOrThrow({ where: { aggregateId: id } })
    const taskBefore = await db.task.findUniqueOrThrow({ where: { id: taskId } })
    expect((await read()).deliveries[0]?.canRetry).toBe(true)
    const responses = await Promise.all([retry(id), retry(id)])
    expect(responses.map((response) => response.status)).toEqual([202, 202])
    const [first, second] = await Promise.all(responses.map((response) => response.json()))
    expect(second).toEqual(first)
    expect(first).toMatchObject({ status: 'ACCEPTED', deliveryId: id })
    expect(await (await retry(id)).json()).toEqual(first)
    const events = await db.outboxEvent.findMany({ where: { aggregateId: id } })
    expect(events).toHaveLength(2)
    expect(events.find((event) => event.id === original.id)).toEqual(original)
    expect(events.find((event) => event.id === first.retryEventId)?.payload).toMatchObject({
      sourceEventId: original.id,
      previousAttemptCount: 3,
      previousErrorCode: 'GITHUB_UNAVAILABLE',
    })
    expect(await db.webhookDelivery.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'ACCEPTED',
      evidenceRetryEventId: first.retryEventId,
      evidenceAttemptCount: 3,
      evidenceFailedAt: null,
      evidenceLastErrorCode: 'GITHUB_UNAVAILABLE',
      agentRunId: null,
    })
    expect(await db.task.findUniqueOrThrow({ where: { id: taskId } })).toEqual(taskBefore)
    expect((await read()).deliveries[0]).toMatchObject({ status: 'RETRYING', canRetry: false })
    await db.outboxEvent.update({
      where: { id: first.retryEventId },
      data: { deadLetteredAt: new Date() },
    })
    expect((await read()).deliveries[0]).toMatchObject({
      status: 'DISPATCH_FAILED',
      canRetry: false,
    })
    expect(app.get(AuthService).requireGitHubToken).not.toHaveBeenCalled()
  })

  it.each(['RESYNC_REQUIRED', 'LIMIT_EXCEEDED', 'INVALID_INTAKE', 'TASK_CHANGED'])(
    'manual recovery does not disguise %s as ordinary retry',
    async (code) => {
      const id = await failed(code)
      expect((await read()).deliveries[0]?.canRetry).toBe(false)
      expect((await retry(id)).status).toBe(409)
      expect(await db.outboxEvent.count({ where: { aggregateId: id } })).toBe(1)
    },
  )

  it('manual recovery rejects stale attempts, in-flight work and already ignored records', async () => {
    const id = await failed()
    expect((await retry(id, 2)).status).toBe(409)
    await db.webhookDelivery.update({ where: { id }, data: { evidenceFailedAt: null } })
    expect((await retry(id)).status).toBe(409)
    await db.webhookDelivery.update({
      where: { id },
      data: { status: 'IGNORED', ignoreReason: 'TARGET_NOT_CHANGED' },
    })
    expect((await retry(id)).status).toBe(409)
    expect(await db.outboxEvent.count({ where: { aggregateId: id } })).toBe(1)
  })

  it('manual recovery never adopts a changed task or a new binding of the same GitHub repo', async () => {
    const id = await failed()
    await db.task.update({
      where: { id: taskId },
      data: { version: 2, targetPath: 'notes/other.md' },
    })
    expect((await read()).deliveries[0]?.canRetry).toBe(false)
    expect((await read()).deliveries[0]?.message).toContain('任务已变化')
    expect((await retry(id)).status).toBe(409)
    const oldRepositoryId = repositoryId
    await db.repository.update({ where: { id: oldRepositoryId }, data: { enabled: false } })
    repositoryId = (await createBinding()).id
    expect((await retry(id, 3, token, environment.WEB_ORIGIN, oldRepositoryId)).status).toBe(404)
    expect((await retry(id)).status).toBe(404)
    expect(await db.outboxEvent.count({ where: { aggregateId: id } })).toBe(1)
  })
})
