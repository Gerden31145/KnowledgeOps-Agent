import 'reflect-metadata'
import { createHmac, randomInt, randomUUID } from 'node:crypto'
import { createDatabaseClient, Prisma, type DatabaseClient } from '@knowledgeops/database'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitHubWebhookService } from '../src/webhooks/github-webhook.service.js'
import { AppModule } from '../src/app.module.js'
import { API_ENVIRONMENT } from '../src/config/config.module.js'
import { readApiEnvironment } from '../src/config/environment.js'
import { DatabaseService } from '../src/database/database.service.js'

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for R05 integration tests')
const database = createDatabaseClient(process.env.DATABASE_URL)
const secret = 'synthetic-r05-webhook-secret-only-32'

describe('R05 intake: real PostgreSQL and signed HTTP; signature fixtures for transaction cases', () => {
  const userIds = [randomUUID(), randomUUID()]
  const repositoryId = randomUUID()
  const installationId = String(Date.now() * 1000 + Math.floor(Math.random() * 1000))
  const githubRepositoryId = String(randomInt(2_000_000_000_000, 3_000_000_000_000))
  const deliveryIds: string[] = []
  const verify = vi.fn(() => true)
  const service = new GitHubWebhookService(database, secret, verify)
  const push = () => ({
    installation: { id: installationId },
    repository: { id: githubRepositoryId },
    ref: 'refs/heads/main',
    before: 'a'.repeat(40),
    after: 'b'.repeat(40),
    deleted: false,
    forced: false,
    sender: { login: 'untrusted-name' },
    commits: [{ message: 'do not store private messages' }],
  })
  const input = (body: unknown = push(), eventType = 'push') => {
    const deliveryId = randomUUID()
    deliveryIds.push(deliveryId)
    return {
      rawBody: Buffer.from(JSON.stringify(body)),
      signature: 'fixture-only',
      deliveryId,
      eventType,
    }
  }
  const outbox = (id: string) => database.outboxEvent.findMany({ where: { aggregateId: id } })
  let app: NestExpressApplication
  let url: string

  beforeAll(async () => {
    await database.user.createMany({ data: userIds.map((id) => ({ id, repositoryVersion: 7 })) })
    await database.gitHubInstallation.create({
      data: {
        id: installationId,
        accountId: '123',
        accountLogin: 'r05-fixture',
        verifiedAt: new Date(),
      },
    })
    await database.repository.create({
      data: {
        id: repositoryId,
        userId: userIds[0]!,
        installationId,
        githubRepositoryId,
        fullName: 'fixture/notes',
        defaultBranch: 'main',
        branch: 'main',
        isPrivate: true,
      },
    })
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(API_ENVIRONMENT)
      .useValue(readApiEnvironment({ GITHUB_WEBHOOK_SECRET: secret }))
      .overrideProvider(DatabaseService)
      .useValue({ client: database })
      .overrideProvider(GitHubWebhookService)
      .useValue(new GitHubWebhookService(database, secret))
      .compile()
    app = module.createNestApplication<NestExpressApplication>({ logger: false, rawBody: true })
    app.useBodyParser('json', { limit: '100kb', inflate: false })
    await app.listen(0, '127.0.0.1')
    url = `${await app.getUrl()}/webhooks/github`
  })

  beforeEach(async () => {
    verify.mockReset().mockReturnValue(true)
    await database.repository.update({
      where: { id: repositoryId },
      data: { enabled: true, unboundAt: null },
    })
    await database.user.updateMany({
      where: { id: { in: userIds } },
      data: { repositoryVersion: 7 },
    })
  })

  afterEach(async () => {
    // Only this suite's UUIDs; no global truncation, reset or deletion of user records.
    await database.outboxEvent.deleteMany({ where: { aggregateId: { in: deliveryIds } } })
    await database.webhookDelivery.deleteMany({ where: { id: { in: deliveryIds } } })
    await database.repository.deleteMany({ where: { userId: userIds[1]! } })
    deliveryIds.length = 0
  })

  afterAll(async () => {
    await app?.close()
    await database.user.deleteMany({ where: { id: { in: userIds } } })
    await database.gitHubInstallation.deleteMany({ where: { id: installationId } })
    await database.$disconnect()
  })

  it('returns 202 only after receipt and one pending intent are committed; stores a minimal payload', async () => {
    const command = input()
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': command.eventType,
        'x-github-delivery': command.deliveryId,
        'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(command.rawBody).digest('hex')}`,
      },
      body: command.rawBody.toString('utf8'),
    })
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ received: true })
    const delivery = await database.webhookDelivery.findUniqueOrThrow({
      where: { id: command.deliveryId },
    })
    expect(delivery).toMatchObject({ status: 'ACCEPTED', ignoreReason: null })
    expect(delivery.payload).not.toHaveProperty('sender')
    expect(delivery.payload).not.toHaveProperty('commits')
    expect(await outbox(command.deliveryId)).toMatchObject([
      {
        type: 'GITHUB_PUSH_RECEIVED',
        dispatchedAt: null,
        dispatchAttemptCount: 0,
        payload: {
          deliveryId: command.deliveryId,
          bindings: [{ repositoryId, userId: userIds[0], repositoryVersion: 7 }],
        },
      },
    ])
  })

  it('rejects a signature failure before persistence', async () => {
    verify.mockReturnValueOnce(false)
    const command = input()
    await expect(service.receive(command)).rejects.toMatchObject({ status: 401 })
    expect(
      await database.webhookDelivery.findUnique({ where: { id: command.deliveryId } }),
    ).toBeNull()
    expect(await outbox(command.deliveryId)).toEqual([])
  })

  it('deduplicates concurrent delivery and a replay handled by a fresh service instance', async () => {
    const command = input()
    expect(await Promise.all(Array.from({ length: 4 }, () => service.receive(command)))).toEqual(
      Array.from({ length: 4 }, () => ({ received: true })),
    )
    await new GitHubWebhookService(database, secret, () => true).receive(command)
    expect(await database.webhookDelivery.count({ where: { id: command.deliveryId } })).toBe(1)
    expect(await outbox(command.deliveryId)).toHaveLength(1)
  })

  it('rejects conflicting content or event type for an existing delivery without replacing it', async () => {
    const command = input()
    await service.receive(command)
    await expect(
      service.receive({
        ...command,
        rawBody: Buffer.from(JSON.stringify({ ...push(), after: 'c'.repeat(40) })),
      }),
    ).rejects.toMatchObject({ status: 409 })
    await expect(service.receive({ ...command, eventType: 'ping' })).rejects.toMatchObject({
      status: 409,
    })
    expect(
      (await database.webhookDelivery.findUniqueOrThrow({ where: { id: command.deliveryId } }))
        .payload,
    ).toMatchObject({ after: 'b'.repeat(40) })
    expect(await outbox(command.deliveryId)).toHaveLength(1)
  })

  it('records ignored deliveries without scheduling unsupported events, refs, deletions or unbound repositories', async () => {
    const examples = [
      { body: {}, event: 'ping', reason: 'EVENT_UNSUPPORTED' },
      { body: { ...push(), ref: 'refs/tags/v1' }, event: 'push', reason: 'REF_UNSUPPORTED' },
      {
        body: { ...push(), deleted: true, after: '0'.repeat(40) },
        event: 'push',
        reason: 'BRANCH_DELETED',
      },
      { body: { ...push(), ref: 'refs/heads/other' }, event: 'push', reason: 'NO_ACTIVE_BINDING' },
      {
        body: { ...push(), installation: { id: '1' } },
        event: 'push',
        reason: 'NO_ACTIVE_BINDING',
      },
      {
        body: { ...push(), repository: { id: '999' } },
        event: 'push',
        reason: 'NO_ACTIVE_BINDING',
      },
    ]
    for (const example of examples) {
      const command = input(example.body, example.event)
      await expect(service.receive(command)).resolves.toEqual({ received: true })
      expect(
        await database.webhookDelivery.findUniqueOrThrow({ where: { id: command.deliveryId } }),
      ).toMatchObject({ status: 'IGNORED', ignoreReason: example.reason })
      expect(await outbox(command.deliveryId)).toEqual([])
    }
  })

  it('rejects a second active owner and records only the existing binding, independent of sender identity', async () => {
    await expect(
      database.repository.create({
        data: {
          userId: userIds[1]!,
          installationId,
          githubRepositoryId,
          fullName: 'fixture/notes',
          defaultBranch: 'main',
          branch: 'main',
          isPrivate: true,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' })
    const command = input()
    await service.receive(command)
    const [event] = await outbox(command.deliveryId)
    expect(event?.payload).toEqual({
      deliveryId: command.deliveryId,
      bindings: [{ repositoryId, userId: userIds[0], repositoryVersion: 7 }],
    })
  })

  it('preserves the original pending intent after ownership changes; new deliveries use the new binding', async () => {
    const oldCommand = input()
    await service.receive(oldCommand)
    const original = await outbox(oldCommand.deliveryId)
    await database.repository.update({
      where: { id: repositoryId },
      data: { enabled: false, unboundAt: new Date() },
    })
    await database.user.updateMany({
      where: { id: { in: userIds } },
      data: { repositoryVersion: { increment: 1 } },
    })
    const replacement = await database.repository.create({
      data: {
        userId: userIds[1]!,
        installationId,
        githubRepositoryId,
        fullName: 'fixture/notes',
        defaultBranch: 'main',
        branch: 'main',
        isPrivate: true,
      },
    })
    await service.receive(oldCommand)
    expect(await outbox(oldCommand.deliveryId)).toEqual(original)
    const next = input()
    await service.receive(next)
    expect((await outbox(next.deliveryId))[0]?.payload).toEqual({
      deliveryId: next.deliveryId,
      bindings: [{ repositoryId: replacement.id, userId: userIds[1], repositoryVersion: 8 }],
    })
  })

  it('rolls back the delivery if writing the intent fails, allowing a later retry', async () => {
    const brokenDatabase = database.$extends({
      query: {
        outboxEvent: {
          async create() {
            throw new Error('synthetic-outbox-write-failure')
          },
        },
      },
    }) as unknown as DatabaseClient
    const command = input()
    await expect(
      new GitHubWebhookService(brokenDatabase, secret, () => true).receive(command),
    ).rejects.toThrow('synthetic-outbox-write-failure')
    expect(
      await database.webhookDelivery.findUnique({ where: { id: command.deliveryId } }),
    ).toBeNull()
    expect(await outbox(command.deliveryId)).toEqual([])
    await service.receive(command)
    expect(await outbox(command.deliveryId)).toHaveLength(1)
  })

  it.each(['unbind', 'replace'] as const)(
    'does not route a received delivery to a replacement after %s between lookup and lock',
    async (change) => {
      let selected!: () => void
      let resume!: () => void
      const bindingSelected = new Promise<void>((resolve) => {
        selected = resolve
      })
      const continueIntake = new Promise<void>((resolve) => {
        resume = resolve
      })
      let reads = 0
      const pausedDatabase = database.$extends({
        query: {
          repository: {
            async findFirst({ args, query }) {
              const result = await query(args)
              if (++reads === 1) {
                selected()
                await continueIntake
              }
              return result
            },
          },
        },
      }) as unknown as DatabaseClient
      const command = input()
      const receiving = new GitHubWebhookService(pausedDatabase, secret, () => true).receive(
        command,
      )
      try {
        await bindingSelected
        await database.$transaction(async (tx) => {
          await tx.$queryRaw(
            Prisma.sql`SELECT id FROM users WHERE id = ${userIds[0]}::uuid FOR UPDATE`,
          )
          await tx.repository.update({
            where: { id: repositoryId },
            data: { enabled: false, unboundAt: new Date() },
          })
          await tx.user.update({
            where: { id: userIds[0]! },
            data: { repositoryVersion: { increment: 1 } },
          })
        })
        if (change === 'replace') {
          await database.repository.create({
            data: {
              userId: userIds[1]!,
              installationId,
              githubRepositoryId,
              fullName: 'fixture/notes',
              defaultBranch: 'main',
              branch: 'main',
              isPrivate: true,
            },
          })
        }
      } finally {
        resume()
      }
      await receiving
      expect(await outbox(command.deliveryId)).toEqual([])
      expect(
        await database.webhookDelivery.findUniqueOrThrow({ where: { id: command.deliveryId } }),
      ).toMatchObject({ status: 'IGNORED', ignoreReason: 'NO_ACTIVE_BINDING' })
    },
  )
})
