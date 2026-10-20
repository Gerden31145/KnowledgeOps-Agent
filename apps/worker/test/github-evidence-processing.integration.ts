import { createHash, randomInt, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildGitHubEvidenceJobId } from '@knowledgeops/contracts'
import { createDatabaseClient, Prisma, type DatabaseClient } from '@knowledgeops/database'
import { Queue, QueueEvents, Worker } from 'bullmq'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { readWorkerEnvironment } from '../src/config/environment.js'
import { GitHubEvidenceJobProcessor } from '../src/github/github-evidence-job-processor.js'
import { GitHubEvidenceError } from '../src/github/github-evidence-http.js'
import { GitHubEvidenceReconciler } from '../src/github/github-evidence-reconciler.js'
import { postgresConnectionGate } from './fixtures/postgres-connection-gate.js'
import type {
  BoundCommitEvidenceReader,
  ReadBoundCommitEvidenceResult,
} from '../src/github/read-bound-commit-evidence.js'
import { OutboxDispatcher } from '../src/outbox/outbox-dispatcher.js'
import { parseGitHubPushOutboxEvent } from '../src/outbox/outbox-event.js'
import {
  BullMqGitHubEvidenceQueue,
  createGitHubEvidenceBullMqProcessor,
} from '../src/queue/bullmq-github-evidence-queue.js'
import { bullMqWorkerConnection } from '../src/queue/bullmq-connections.js'
import { RepositoryEvidenceRetryService } from '../../api/src/repositories/repository-evidence-retry.service.js'
import { RepositoryEvidenceService } from '../../api/src/repositories/repository-evidence.service.js'
import type { DatabaseService } from '../../api/src/database/database.service.js'
import { readCommitEvidence } from '../src/github/read-commit-evidence.js'

// PostgreSQL + Redis 为真实实例；只创建本文件的随机记录/队列，GitHub 读取端口用合成结果。
const environment = readWorkerEnvironment()
const database = createDatabaseClient(environment.DATABASE_URL)
const fixtures: {
  userId: string
  taskId: string
  eventId: string
  deliveryId: string
  installationId: string
}[] = []
const resources: (() => Promise<void>)[] = []
const retryPolicy = { baseDelayMs: 100, maxDelayMs: 1_000 }
const firstAttempt = { number: 1, maxAttempts: 3 }

async function fixture(park = false) {
  const userId = randomUUID(),
    taskId = randomUUID(),
    repositoryId = randomUUID()
  const eventId = randomUUID(),
    deliveryId = randomUUID()
  const installationId = String(randomInt(6_000_000_000_000, 7_000_000_000_000))
  const githubRepositoryId = String(randomInt(7_000_000_000_000, 8_000_000_000_000))
  const targetPath = 'notes/vue.md',
    before = 'a'.repeat(40),
    after = 'b'.repeat(40)
  const binding = { repositoryId, userId, repositoryVersion: 7 }
  const content = '# Vue\nfixture\n'
  const collected: ReadBoundCommitEvidenceResult = {
    status: 'COLLECTED',
    evidence: {
      githubRepositoryId,
      beforeCommitSha: before,
      afterCommitSha: after,
      targetPath,
      previousPath: null,
      change: 'modified',
      sourceCommitSha: after,
      content,
      contentHash: createHash('sha256').update(content).digest('hex'),
      lineCount: 2,
      diff: '@@ -1 +1,2 @@\n # Vue\n+fixture',
    },
  }
  await database.user.create({
    data: {
      id: userId,
      repositoryVersion: 7,
      goals: {
        create: {
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
                      targetPath,
                      version: 3,
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  })
  await database.gitHubInstallation.create({
    data: { id: installationId, accountId: '42', accountLogin: 'fixture', verifiedAt: new Date() },
  })
  await database.repository.create({
    data: {
      id: repositoryId,
      userId,
      installationId,
      githubRepositoryId,
      fullName: 'fixture/notes',
      branch: 'main',
      defaultBranch: 'main',
      isPrivate: true,
    },
  })
  await database.$transaction([
    database.webhookDelivery.create({
      data: {
        id: deliveryId,
        eventType: 'push',
        payloadHash: '0'.repeat(64),
        status: 'ACCEPTED',
        receivedRepositoryId: repositoryId,
        payload: {
          installation: { id: installationId },
          repository: { id: githubRepositoryId },
          ref: 'refs/heads/main',
          before,
          after,
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
        schemaVersion: 2,
        availableAt: park ? new Date('2099-01-01T00:00:00Z') : new Date(),
        payload: { deliveryId, binding, task: { taskId, taskVersion: 3, targetPath } },
      },
    }),
  ])
  const result = {
    userId,
    taskId,
    eventId,
    deliveryId,
    installationId,
    collected,
    binding,
    githubRepositoryId,
    targetPath,
    before,
    after,
    payload: { eventId, deliveryId },
    savedDelivery: () => database.webhookDelivery.findUniqueOrThrow({ where: { id: deliveryId } }),
    savedTask: () => database.task.findUniqueOrThrow({ where: { id: taskId } }),
    message: async () =>
      parseGitHubPushOutboxEvent(
        await database.outboxEvent.findUniqueOrThrow({ where: { id: eventId } }),
      ),
  }
  fixtures.push(result)
  return result
}

async function queueFor(processor: Pick<GitHubEvidenceJobProcessor, 'process'>) {
  // 名称只来自测试前缀+随机 UUID；清理绝不触碰正式 github-evidence/plan-generation 队列。
  const queueName = `r06-evidence-test-${randomUUID()}`
  if (!/^r06-evidence-test-[0-9a-f-]{36}$/.test(queueName))
    throw new Error('Unsafe test queue name')
  const transport = new BullMqGitHubEvidenceQueue({
    redisUrl: environment.REDIS_URL,
    queueName,
    concurrency: 1,
    jobOptions: { attempts: 3, backoffDelayMs: 30 },
    processor,
  })
  const inspector = new Queue(queueName, {
    connection: { url: environment.REDIS_URL, maxRetriesPerRequest: 1 },
  })
  const events = new QueueEvents(queueName, {
    connection: { url: environment.REDIS_URL, maxRetriesPerRequest: null },
  })
  resources.push(async () => {
    try {
      await transport.close()
    } finally {
      await events.close()
      try {
        // 只清理上方校验过的随机测试队列，也能回收崩溃测试留下的 active Job。
        await inspector.obliterate({ force: true })
      } finally {
        await inspector.close()
      }
    }
  })
  await Promise.all([
    transport.waitUntilReady(),
    inspector.waitUntilReady(),
    events.waitUntilReady(),
  ])
  return { transport, inspector, events, queueName }
}

async function startCrashFixture(
  f: Awaited<ReturnType<typeof fixture>>,
  queueName: string,
  checkpoint: 'before-commit' | 'after-commit',
) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(new URL('./fixtures/github-evidence-crash-worker.ts', import.meta.url)),
    ],
    {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
      env: {
        DATABASE_URL: environment.DATABASE_URL,
        REDIS_URL: environment.REDIS_URL,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
        ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
      },
    },
  )
  child.stderr?.resume()
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()))
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
  }
  resources.push(stop)
  const reached = new Promise<void>((resolve, reject) => {
    child.once('error', () => reject(new Error('Crash fixture could not start')))
    child.once('exit', () => reject(new Error('Crash fixture exited before checkpoint')))
    child.once('message', (message: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'event' in message &&
        message.event ===
          (checkpoint === 'before-commit' ? 'uncommitted-handoff' : 'committed-before-ack')
      )
        resolve()
      else reject(new Error('Crash fixture failed before checkpoint'))
    })
  })
  child.send({ queueName, payload: f.payload, collected: f.collected, checkpoint })
  await reached
  return { child, stop }
}

function reconcilerFor(
  client: DatabaseClient,
  queue: BullMqGitHubEvidenceQueue,
  deliveryId: string,
) {
  const scoped = client.$extends({
    query: {
      webhookDelivery: {
        findMany({ args, query }) {
          return query({ ...args, where: { AND: [args.where ?? {}, { id: deliveryId }] } })
        },
      },
    },
  }) as DatabaseClient
  return new GitHubEvidenceReconciler(scoped, queue)
}

beforeAll(async () => {
  await database.$connect()
})
afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close()
  for (const f of fixtures.splice(0)) {
    const runs = await database.agentRun.findMany({
      where: { taskId: f.taskId },
      select: { id: true },
    })
    await database.outboxEvent.deleteMany({
      where: {
        OR: [
          { aggregateId: f.deliveryId },
          { type: 'NOTE_VERIFICATION_REQUESTED', aggregateId: { in: runs.map((run) => run.id) } },
        ],
      },
    })
    await database.webhookDelivery.deleteMany({ where: { id: f.deliveryId } })
    await database.agentRun.deleteMany({ where: { taskId: f.taskId } })
    await database.submission.deleteMany({ where: { taskId: f.taskId } })
    await database.user.deleteMany({ where: { id: f.userId } })
    await database.gitHubInstallation.deleteMany({ where: { id: f.installationId } })
  }
})
afterAll(async () => {
  await database.$disconnect()
})

describe('R06 snapshot resync', () => {
  type Fixture = Awaited<ReturnType<typeof fixture>>
  const recovery = () =>
    new RepositoryEvidenceRetryService({ client: database }, () => new Date('2099-01-01T00:00:00Z'))
  const request = (f: Fixture, count = 1) =>
    recovery().resync(f.userId, f.binding.repositoryId, f.deliveryId, {
      expectedAttemptCount: count,
    })
  const snapshot = (f: Fixture): ReadBoundCommitEvidenceResult => {
    if (f.collected.status !== 'COLLECTED') throw new Error('Expected fixture evidence')
    return {
      status: 'COLLECTED',
      evidence: {
        ...f.collected.evidence,
        mode: 'SNAPSHOT',
        change: null,
        diff: null,
        previousPath: null,
      },
    }
  }
  const fail = async (f: Fixture) => {
    await expect(
      new GitHubEvidenceJobProcessor(database, {
        read: async () => {
          throw new GitHubEvidenceError('RESYNC_REQUIRED')
        },
      }).process(f.payload, firstAttempt),
    ).rejects.toMatchObject({ code: 'RESYNC_REQUIRED', retryable: false })
  }

  it('recovers a missing baseline through the existing queue into one fixed-SHA snapshot and a queued verification run', async () => {
    const f = await fixture(true)
    if (f.collected.status !== 'COLLECTED') throw new Error('Expected fixture evidence')
    const content = f.collected.evidence.content
    const bytes = Buffer.from(content)
    const blobSha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
    const treeSha = 'd'.repeat(40)
    const fetchGitHub = vi.fn<typeof fetch>(async (url) => {
      const parsed = new URL(String(url))
      if (parsed.pathname === `/repositories/${f.githubRepositoryId}`)
        return Response.json({ id: Number(f.githubRepositoryId), full_name: 'fixture/notes' })
      if (parsed.pathname.includes('/compare/') || parsed.pathname.endsWith(`/commits/${f.before}`))
        return new Response(null, { status: 404 })
      if (parsed.pathname === `/repos/fixture/notes/git/commits/${f.after}`)
        return Response.json({ sha: f.after, tree: { sha: treeSha } })
      if (parsed.pathname === `/repos/fixture/notes/git/trees/${treeSha}`)
        return Response.json({
          sha: treeSha,
          truncated: false,
          tree: [{ path: f.targetPath, sha: blobSha, mode: '100644', type: 'blob' }],
        })
      if (
        parsed.pathname === `/repos/fixture/notes/contents/${f.targetPath}` &&
        parsed.searchParams.get('ref') === f.after
      )
        return Response.json({
          type: 'file',
          path: f.targetPath,
          sha: blobSha,
          size: bytes.length,
          encoding: 'base64',
          content: bytes.toString('base64'),
        })
      throw new Error('Unexpected or unpinned fixture request')
    })
    const read = vi.fn<BoundCommitEvidenceReader['read']>((command) =>
      readCommitEvidence(command, {
        installationToken: 'fixture-token',
        fetchGitHub,
        evidenceMode: command.evidenceMode ?? 'DIFF',
      }),
    )
    const processor = new GitHubEvidenceJobProcessor(database, { read })
    const { transport, inspector, events } = await queueFor(processor)
    await transport.publish(await f.message())
    const original = await inspector.getJob(buildGitHubEvidenceJobId(f.deliveryId))
    transport.start()
    await expect(original!.waitUntilFinished(events, 10_000)).rejects.toThrow('RESYNC_REQUIRED')
    expect(await database.agentRun.count({ where: { taskId: f.taskId } })).toBe(0)
    fetchGitHub.mockClear()
    const [accepted, duplicate] = await Promise.all([request(f), request(f)])
    expect(duplicate).toEqual(accepted)
    const dispatcher = new OutboxDispatcher(
      database,
      { publish: vi.fn(), publishGitHubEvidenceRetry: (message) => transport.publish(message) },
      retryPolicy,
      () => new Date('2099-01-01T00:00:01Z'),
    )
    expect(await dispatcher.dispatchEvent(accepted.retryEventId)).toMatchObject({
      status: 'DISPATCHED',
    })
    const job = await inspector.getJob(
      buildGitHubEvidenceJobId(f.deliveryId, accepted.retryEventId),
    )
    expect(job?.data).toEqual({ ...f.payload, retryEventId: accepted.retryEventId })
    const result = await job!.waitUntilFinished(events, 10_000)
    expect(result).toMatchObject({ status: 'PROCESSED' })
    const saved = await database.submission.findUniqueOrThrow({
      where: { id: result.submissionId },
      include: { evidence: true, runs: true },
    })
    expect(saved).toMatchObject({
      beforeCommitSha: f.before,
      afterCommitSha: f.after,
      targetPath: f.targetPath,
      evidence: {
        mode: 'SNAPSHOT',
        change: null,
        diff: null,
        previousPath: null,
        content,
        sourceCommitSha: f.after,
      },
    })
    expect(saved.runs).toHaveLength(1)
    // 数据库也拒绝给快照塞入伪造 Diff，而不是只依赖应用分支。
    await expect(
      database.evidence.update({ where: { submissionId: saved.id }, data: { diff: 'fake diff' } }),
    ).rejects.toThrow()
    expect(saved.runs[0]).toMatchObject({ status: 'QUEUED', kind: 'NOTE_VERIFICATION' })
    expect(await f.savedTask()).toMatchObject({ state: 'VERIFYING', version: 4 })
    expect(await original!.getState()).toBe('failed')
    expect(await request(f)).toEqual(accepted)
    expect(
      await processor.process({ ...f.payload, retryEventId: accepted.retryEventId }, firstAttempt),
    ).toEqual(result)
    expect(read).toHaveBeenCalledTimes(2)
    expect(read.mock.calls[1]?.[0]).toMatchObject({
      evidenceMode: 'SNAPSHOT',
      afterCommitSha: f.after,
      targetPath: f.targetPath,
    })
    expect(fetchGitHub.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      `/repositories/${f.githubRepositoryId}`,
      `/repos/fixture/notes/git/commits/${f.after}`,
      `/repos/fixture/notes/git/trees/${treeSha}`,
      `/repos/fixture/notes/contents/${f.targetPath}`,
    ])
    expect(
      await database.outboxEvent.count({
        where: { type: 'NOTE_VERIFICATION_REQUESTED', aggregateId: saved.runs[0]!.id },
      }),
    ).toBe(1)
  })

  it('rejects a reader-selected snapshot without a persisted resync request', async () => {
    const f = await fixture(true)
    await expect(
      new GitHubEvidenceJobProcessor(database, { read: async () => snapshot(f) }).process(
        f.payload,
        firstAttempt,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_EVIDENCE' })
    expect(await database.submission.count({ where: { taskId: f.taskId } })).toBe(0)
    expect(await f.savedTask()).toMatchObject({ state: 'IN_PROGRESS', version: 3 })
  })

  it('rejects a Diff result from a snapshot request instead of silently changing its semantics', async () => {
    const f = await fixture(true)
    await fail(f)
    const accepted = await request(f)
    await expect(
      new GitHubEvidenceJobProcessor(database, { read: async () => f.collected }).process(
        { ...f.payload, retryEventId: accepted.retryEventId },
        firstAttempt,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_EVIDENCE' })
    expect(await database.submission.count({ where: { taskId: f.taskId } })).toBe(0)
  })

  it.each(['success', 'failure'] as const)(
    'rejects late old-round %s after snapshot resync is accepted',
    async (outcome) => {
      const f = await fixture(true)
      let release!: () => void, notify!: () => void
      const started = new Promise<void>((resolve) => {
        notify = resolve
      })
      const old = new GitHubEvidenceJobProcessor(database, {
        read: async () => {
          notify()
          await new Promise<void>((resolve) => {
            release = resolve
          })
          if (outcome === 'failure') throw new GitHubEvidenceError('GITHUB_UNAVAILABLE')
          return f.collected
        },
      }).process(f.payload, firstAttempt)
      const rejection = expect(old).rejects.toMatchObject({
        code: outcome === 'success' ? 'RETRY_SUPERSEDED' : 'GITHUB_UNAVAILABLE',
      })
      await started
      await fail(f)
      const accepted = await request(f, 2)
      release()
      await rejection
      expect(await f.savedDelivery()).toMatchObject({
        status: 'ACCEPTED',
        evidenceRetryEventId: accepted.retryEventId,
        evidenceLastErrorCode: 'RESYNC_REQUIRED',
        evidenceFailedAt: null,
      })
      expect(await database.submission.count({ where: { taskId: f.taskId } })).toBe(0)
    },
  )

  it.each(['binding', 'task'] as const)(
    'rechecks the original %s after snapshot resync acceptance',
    async (kind) => {
      const f = await fixture(true)
      await fail(f)
      const accepted = await request(f)
      if (kind === 'binding')
        await database.repository.update({
          where: { id: f.binding.repositoryId },
          data: { enabled: false },
        })
      else
        await database.task.update({ where: { id: f.taskId }, data: { version: { increment: 1 } } })
      expect(
        await new GitHubEvidenceJobProcessor(database, { read: async () => snapshot(f) }).process(
          { ...f.payload, retryEventId: accepted.retryEventId },
          firstAttempt,
        ),
      ).toEqual({
        status: 'IGNORED',
        reason: kind === 'binding' ? 'BINDING_CHANGED' : 'TASK_CHANGED',
      })
      expect(await database.submission.count({ where: { taskId: f.taskId } })).toBe(0)
    },
  )

  it('rolls back a failed snapshot handoff and keeps SNAPSHOT mode on a subsequent ordinary retry', async () => {
    const f = await fixture(true)
    await fail(f)
    const accepted = await request(f)
    const broken = database.$extends({
      query: {
        outboxEvent: {
          async create({ args, query }) {
            if (args.data.type === 'NOTE_VERIFICATION_REQUESTED')
              throw new Error('fixture handoff failure')
            return query(args)
          },
        },
      },
    }) as DatabaseClient
    const read = vi.fn<BoundCommitEvidenceReader['read']>().mockResolvedValue(snapshot(f))
    await expect(
      new GitHubEvidenceJobProcessor(broken, { read }).process(
        { ...f.payload, retryEventId: accepted.retryEventId },
        { number: 1, maxAttempts: 1 },
      ),
    ).rejects.toMatchObject({ code: 'EVIDENCE_PROCESSING_FAILED' })
    expect(await database.submission.count({ where: { taskId: f.taskId } })).toBe(0)
    expect(await f.savedTask()).toMatchObject({ state: 'IN_PROGRESS', version: 3 })
    const next = await recovery().retry(f.userId, f.binding.repositoryId, f.deliveryId, {
      expectedAttemptCount: 2,
    })
    await new GitHubEvidenceJobProcessor(database, { read }).process(
      { ...f.payload, retryEventId: next.retryEventId },
      firstAttempt,
    )
    expect(read.mock.calls.every(([input]) => input.evidenceMode === 'SNAPSHOT')).toBe(true)
    expect(await database.agentRun.count({ where: { taskId: f.taskId } })).toBe(1)
  })

  it.each([
    { diff: 'fabricated diff' },
    { change: 'modified' },
    { previousPath: 'other.md' },
    { sourceCommitSha: 'c'.repeat(40) },
    { afterCommitSha: 'c'.repeat(40) },
  ])('rejects malformed or retargeted snapshot evidence %j', async (patch) => {
    const f = await fixture(true)
    await fail(f)
    const accepted = await request(f)
    const result = snapshot(f)
    if (result.status !== 'COLLECTED') throw new Error('Expected fixture evidence')
    Object.assign(result.evidence, patch)
    await expect(
      new GitHubEvidenceJobProcessor(database, { read: async () => result }).process(
        { ...f.payload, retryEventId: accepted.retryEventId },
        firstAttempt,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_EVIDENCE' })
    expect(await database.submission.count({ where: { taskId: f.taskId } })).toBe(0)
    expect(await f.savedTask()).toMatchObject({ state: 'IN_PROGRESS', version: 3 })
  })

  it('still processes a persisted legacy v1 retry as DIFF, never as snapshot consent', async () => {
    const f = await fixture(true)
    await expect(
      new GitHubEvidenceJobProcessor(database, {
        read: async () => {
          throw new GitHubEvidenceError('GITHUB_AUTH_REQUIRED')
        },
      }).process(f.payload, firstAttempt),
    ).rejects.toMatchObject({ code: 'GITHUB_AUTH_REQUIRED' })
    const accepted = await recovery().retry(f.userId, f.binding.repositoryId, f.deliveryId, {
      expectedAttemptCount: 1,
    })
    await database.outboxEvent.update({
      where: { id: accepted.retryEventId },
      data: {
        schemaVersion: 1,
        payload: {
          deliveryId: f.deliveryId,
          sourceEventId: f.eventId,
          previousAttemptCount: 1,
          previousErrorCode: 'GITHUB_AUTH_REQUIRED',
          previousFailedAt: new Date().toISOString(),
        },
      },
    })
    const read = vi.fn<BoundCommitEvidenceReader['read']>().mockResolvedValue(f.collected)
    await new GitHubEvidenceJobProcessor(database, { read }).process(
      { ...f.payload, retryEventId: accepted.retryEventId },
      firstAttempt,
    )
    expect(read.mock.calls[0]![0].evidenceMode).toBeUndefined()
    const saved = await database.submission.findFirstOrThrow({
      where: { taskId: f.taskId },
      include: { evidence: true },
    })
    expect(saved.evidence).toMatchObject({
      mode: 'DIFF',
      change: 'modified',
      diff: expect.any(String),
    })
  })

  it('persists a missing current file as a safe failure, never an empty snapshot or deletion', async () => {
    const f = await fixture(true)
    await fail(f)
    const accepted = await request(f)
    await expect(
      new GitHubEvidenceJobProcessor(database, {
        read: async () => {
          throw new GitHubEvidenceError('SOURCE_UNAVAILABLE')
        },
      }).process({ ...f.payload, retryEventId: accepted.retryEventId }, firstAttempt),
    ).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE', retryable: false })
    expect(await f.savedDelivery()).toMatchObject({
      status: 'ACCEPTED',
      agentRunId: null,
      evidenceFailedAt: expect.any(Date),
    })
    expect(await database.submission.count({ where: { taskId: f.taskId } })).toBe(0)
  })
})

describe('R06 manual evidence recovery', () => {
  const recovery = (db = database) =>
    new RepositoryEvidenceRetryService({ client: db }, () => new Date('2099-01-01T00:00:00Z'))
  const request = (f: Awaited<ReturnType<typeof fixture>>, count: number, db = database) =>
    recovery(db).retry(f.userId, f.binding.repositoryId, f.deliveryId, {
      expectedAttemptCount: count,
    })
  const fail = async (f: Awaited<ReturnType<typeof fixture>>, retryEventId?: string) => {
    const processor = new GitHubEvidenceJobProcessor(database, {
      read: async () => {
        throw new GitHubEvidenceError('GITHUB_AUTH_REQUIRED')
      },
    })
    await expect(
      processor.process({ ...f.payload, ...(retryEventId ? { retryEventId } : {}) }, firstAttempt),
    ).rejects.toMatchObject({ code: 'GITHUB_AUTH_REQUIRED' })
  }

  it('recovers a retained failed BullMQ job through a durable request, including lost dispatch acknowledgement', async () => {
    const f = await fixture(true)
    const read = vi
      .fn<BoundCommitEvidenceReader['read']>()
      .mockRejectedValueOnce(new GitHubEvidenceError('GITHUB_AUTH_REQUIRED'))
      .mockResolvedValue(f.collected)
    const { transport, inspector, events } = await queueFor(
      new GitHubEvidenceJobProcessor(database, { read }),
    )
    await transport.publish(await f.message())
    const originalJob = await inspector.getJob(buildGitHubEvidenceJobId(f.deliveryId))
    transport.start()
    await expect(originalJob!.waitUntilFinished(events, 10_000)).rejects.toThrow(
      'GITHUB_AUTH_REQUIRED',
    )
    const sourceBefore = await database.outboxEvent.findUniqueOrThrow({ where: { id: f.eventId } })
    const [accepted, duplicate] = await Promise.all([request(f, 1), request(f, 1)])
    expect(duplicate).toEqual(accepted)
    let first = true
    let now = new Date('2099-01-01T00:00:01Z')
    const dispatcher = new OutboxDispatcher(
      database,
      {
        publish: vi.fn(),
        publishGitHubEvidenceRetry: async (message) => {
          const result = await transport.publish(message)
          if (first) {
            first = false
            throw new Error('fixture: lost acknowledgement')
          }
          return result
        },
      },
      retryPolicy,
      () => now,
    )
    expect(await dispatcher.dispatchEvent(accepted.retryEventId)).toMatchObject({
      status: 'RETRY_SCHEDULED',
    })
    now = new Date(now.getTime() + 1_000)
    expect(await dispatcher.dispatchEvent(accepted.retryEventId)).toMatchObject({
      status: 'DISPATCHED',
    })
    const retryJob = await inspector.getJob(
      buildGitHubEvidenceJobId(f.deliveryId, accepted.retryEventId),
    )
    expect(retryJob?.data).toEqual({ ...f.payload, retryEventId: accepted.retryEventId })
    expect(await retryJob!.waitUntilFinished(events, 10_000)).toMatchObject({ status: 'PROCESSED' })
    expect(await originalJob!.getState()).toBe('failed')
    expect(read).toHaveBeenCalledTimes(2)
    expect(read.mock.calls[1]).toEqual(read.mock.calls[0])
    expect(await f.savedDelivery()).toMatchObject({
      status: 'PROCESSED',
      evidenceAttemptCount: 2,
      evidenceFailedAt: null,
    })
    expect(await database.agentRun.count({ where: { taskId: f.taskId } })).toBe(1)
    expect(await database.submission.count({ where: { taskId: f.taskId } })).toBe(1)
    expect(await request(f, 1)).toEqual(accepted)
    expect(
      await database.outboxEvent.count({
        where: { aggregateId: f.deliveryId, type: 'GITHUB_EVIDENCE_RETRY_REQUESTED' },
      }),
    ).toBe(1)
    expect(await database.outboxEvent.findUniqueOrThrow({ where: { id: f.eventId } })).toEqual(
      sourceBefore,
    )
  })

  it.each(['success', 'failure'] as const)(
    'rejects late old %s after a recovery request is accepted',
    async (outcome) => {
      const f = await fixture(true)
      let release!: () => void
      let notify!: () => void
      const started = new Promise<void>((resolve) => {
        notify = resolve
      })
      const oldRead = vi.fn<BoundCommitEvidenceReader['read']>().mockImplementation(async () => {
        notify()
        await new Promise<void>((resolve) => {
          release = resolve
        })
        if (outcome === 'failure') throw new GitHubEvidenceError('GITHUB_UNAVAILABLE')
        return f.collected
      })
      const oldProcessor = new GitHubEvidenceJobProcessor(database, { read: oldRead })
      const old = oldProcessor.process(f.payload, firstAttempt)
      const oldRejection = expect(old).rejects.toMatchObject({
        code: outcome === 'success' ? 'RETRY_SUPERSEDED' : 'GITHUB_UNAVAILABLE',
      })
      await started
      await fail(f) // 模拟锁丢失后的第二次消费已失败，旧网络请求仍未返回。
      const accepted = await request(f, 2)
      release()
      await oldRejection
      expect(await f.savedDelivery()).toMatchObject({
        status: 'ACCEPTED',
        evidenceAttemptCount: 2,
        evidenceRetryEventId: accepted.retryEventId,
        evidenceFailedAt: null,
        evidenceLastErrorCode: 'GITHUB_AUTH_REQUIRED',
      })
      await expect(oldProcessor.process(f.payload, firstAttempt)).rejects.toMatchObject({
        code: 'RETRY_SUPERSEDED',
      })
      expect(oldRead).toHaveBeenCalledTimes(1)
      expect(await database.submission.count({ where: { taskId: f.taskId } })).toBe(0)
      await new GitHubEvidenceJobProcessor(database, { read: async () => f.collected }).process(
        { ...f.payload, retryEventId: accepted.retryEventId },
        firstAttempt,
      )
      expect(await database.agentRun.count({ where: { taskId: f.taskId } })).toBe(1)
    },
  )

  it('rolls back the request and leaves the original failure intact when the pointer write fails', async () => {
    const f = await fixture(true)
    await fail(f)
    const before = await f.savedDelivery()
    const broken = database.$extends({
      query: {
        webhookDelivery: {
          async update() {
            throw new Error('fixture pointer failure')
          },
        },
      },
    }) as DatabaseClient
    await expect(request(f, 1, broken)).rejects.toThrow('fixture pointer failure')
    expect(await f.savedDelivery()).toEqual(before)
    expect(await database.outboxEvent.count({ where: { aggregateId: f.deliveryId } })).toBe(1)
  })

  it('keeps repeated requests idempotent across multiple failed rounds without reviving an older round', async () => {
    const f = await fixture(true)
    await fail(f)
    const first = await request(f, 1)
    await fail(f, first.retryEventId)
    const second = await request(f, 2)
    expect(second.retryEventId).not.toBe(first.retryEventId)
    expect(await request(f, 1)).toEqual(first)
    expect((await f.savedDelivery()).evidenceRetryEventId).toBe(second.retryEventId)
    const read = vi.fn<BoundCommitEvidenceReader['read']>().mockResolvedValue(f.collected)
    const processor = new GitHubEvidenceJobProcessor(database, { read })
    await expect(
      processor.process({ ...f.payload, retryEventId: first.retryEventId }, firstAttempt),
    ).rejects.toMatchObject({ code: 'RETRY_SUPERSEDED' })
    expect(read).not.toHaveBeenCalled()
    await processor.process({ ...f.payload, retryEventId: second.retryEventId }, firstAttempt)
    expect((await f.savedDelivery()).evidenceAttemptCount).toBe(3)
  })

  it.each(['binding', 'task'] as const)(
    'rechecks a changed %s after request acceptance, without storing evidence or creating a Run',
    async (kind) => {
      const f = await fixture(true)
      await fail(f)
      const accepted = await request(f, 1)
      if (kind === 'binding')
        await database.repository.update({
          where: { id: f.binding.repositoryId },
          data: { enabled: false },
        })
      else
        await database.task.update({
          where: { id: f.taskId },
          data: { version: { increment: 1 }, targetPath: 'notes/other.md' },
        })
      const processor = new GitHubEvidenceJobProcessor(database, { read: async () => f.collected })
      expect(
        await processor.process(
          { ...f.payload, retryEventId: accepted.retryEventId },
          firstAttempt,
        ),
      ).toEqual({
        status: 'IGNORED',
        reason: kind === 'binding' ? 'BINDING_CHANGED' : 'TASK_CHANGED',
      })
      expect(await database.submission.count({ where: { taskId: f.taskId } })).toBe(0)
      expect(await database.agentRun.count({ where: { taskId: f.taskId } })).toBe(0)
    },
  )
})

describe('R06 evidence consumer against PostgreSQL', () => {
  it('uses the receipt snapshot, finalizes, and skips upstream reads on repeat delivery', async () => {
    const f = await fixture()
    const read = vi.fn<BoundCommitEvidenceReader['read']>().mockResolvedValue(f.collected)
    const processor = new GitHubEvidenceJobProcessor(database, { read })
    const result = await processor.process(f.payload, firstAttempt)
    expect(result.status).toBe('PROCESSED')
    expect(read).toHaveBeenCalledWith({
      ...f.binding,
      installationId: f.installationId,
      githubRepositoryId: f.githubRepositoryId,
      ref: 'refs/heads/main',
      beforeCommitSha: f.before,
      afterCommitSha: f.after,
      targetPath: f.targetPath,
    })
    expect(await processor.process(f.payload, firstAttempt)).toEqual(result)
    expect(read).toHaveBeenCalledTimes(1)
    expect(await f.savedDelivery()).toMatchObject({
      status: 'PROCESSED',
      evidenceAttemptCount: 1,
      evidenceLastErrorCode: null,
      evidenceFailedAt: null,
    })
    expect(await f.savedTask()).toMatchObject({ state: 'VERIFYING', version: 4 })
  })

  it('persists a retryable failure without a Run, then a restarted processor uses the same receipt', async () => {
    const f = await fixture()
    const read = vi
      .fn<BoundCommitEvidenceReader['read']>()
      .mockRejectedValueOnce(new GitHubEvidenceError('GITHUB_UNAVAILABLE'))
      .mockResolvedValue(f.collected)
    await expect(
      new GitHubEvidenceJobProcessor(database, { read }).process(f.payload, firstAttempt),
    ).rejects.toMatchObject({ code: 'GITHUB_UNAVAILABLE', retryable: true })
    expect(await f.savedDelivery()).toMatchObject({
      status: 'ACCEPTED',
      evidenceAttemptCount: 1,
      evidenceLastErrorCode: 'GITHUB_UNAVAILABLE',
      evidenceFailedAt: null,
      agentRunId: null,
    })
    expect(await f.savedTask()).toMatchObject({ state: 'IN_PROGRESS', version: 3 })
    expect(await database.submission.count({ where: { taskId: f.taskId } })).toBe(0)
    await new GitHubEvidenceJobProcessor(database, { read }).process(f.payload, {
      number: 2,
      maxAttempts: 3,
    })
    expect(await f.savedDelivery()).toMatchObject({
      status: 'PROCESSED',
      evidenceAttemptCount: 2,
      evidenceLastErrorCode: null,
    })
  })

  it('keeps a final failure queryable without marking the learning task failed', async () => {
    const f = await fixture()
    const read = vi
      .fn<BoundCommitEvidenceReader['read']>()
      .mockRejectedValue(new GitHubEvidenceError('GITHUB_AUTH_REQUIRED'))
    await expect(
      new GitHubEvidenceJobProcessor(database, { read }).process(f.payload, firstAttempt),
    ).rejects.toMatchObject({ retryable: false })
    expect(await f.savedDelivery()).toMatchObject({
      status: 'ACCEPTED',
      evidenceLastErrorCode: 'GITHUB_AUTH_REQUIRED',
      evidenceFailedAt: expect.any(Date),
      agentRunId: null,
    })
    expect(await f.savedTask()).toMatchObject({ state: 'IN_PROGRESS', version: 3 })
  })

  it('persists ignored evidence and never creates an acceptance run', async () => {
    const f = await fixture()
    const read = vi
      .fn<BoundCommitEvidenceReader['read']>()
      .mockResolvedValue({ status: 'IGNORED', reason: 'TARGET_NOT_CHANGED' })
    const processor = new GitHubEvidenceJobProcessor(database, { read })
    await expect(processor.process(f.payload, firstAttempt)).resolves.toEqual({
      status: 'IGNORED',
      reason: 'TARGET_NOT_CHANGED',
    })
    await processor.process(f.payload, firstAttempt)
    expect(read).toHaveBeenCalledTimes(1)
    expect(await f.savedDelivery()).toMatchObject({
      status: 'IGNORED',
      ignoreReason: 'TARGET_NOT_CHANGED',
      agentRunId: null,
    })
  })

  it('does not redirect a receipt to a changed task path while upstream is being read', async () => {
    const f = await fixture()
    const processor = new GitHubEvidenceJobProcessor(database, {
      read: async () => {
        await database.task.update({
          where: { id: f.taskId },
          data: { targetPath: 'notes/other.md', version: { increment: 1 } },
        })
        return f.collected
      },
    })
    await expect(processor.process(f.payload, firstAttempt)).resolves.toEqual({
      status: 'IGNORED',
      reason: 'TASK_CHANGED',
    })
    expect(await database.submission.count({ where: { taskId: f.taskId } })).toBe(0)
  })

  it('rejects a message pairing the event with another delivery before any writes or network', async () => {
    const f = await fixture()
    const read = vi.fn<BoundCommitEvidenceReader['read']>()
    await expect(
      new GitHubEvidenceJobProcessor(database, { read }).process(
        { eventId: f.eventId, deliveryId: randomUUID() },
        firstAttempt,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INTAKE' })
    expect(read).not.toHaveBeenCalled()
    expect(await f.savedDelivery()).toMatchObject({ evidenceAttemptCount: 0 })
  })

  it('rolls back a failed handoff, records only a safe failure code, and can retry', async () => {
    const f = await fixture()
    const broken = database.$extends({
      query: {
        outboxEvent: {
          async create({ args, query }) {
            if (args.data.type === 'NOTE_VERIFICATION_REQUESTED')
              throw new Error('fixture-secret private payload')
            return query(args)
          },
        },
      },
    }) as DatabaseClient
    const read = vi.fn<BoundCommitEvidenceReader['read']>().mockResolvedValue(f.collected)
    await expect(
      new GitHubEvidenceJobProcessor(broken, { read }).process(f.payload, firstAttempt),
    ).rejects.toMatchObject({ code: 'EVIDENCE_PROCESSING_FAILED' })
    expect(await f.savedTask()).toMatchObject({ state: 'IN_PROGRESS', version: 3 })
    expect(await database.submission.count({ where: { taskId: f.taskId } })).toBe(0)
    expect(await f.savedDelivery()).toMatchObject({
      status: 'ACCEPTED',
      evidenceLastErrorCode: 'EVIDENCE_PROCESSING_FAILED',
    })
    await new GitHubEvidenceJobProcessor(database, { read }).process(f.payload, {
      number: 2,
      maxAttempts: 3,
    })
    expect(await database.agentRun.count({ where: { taskId: f.taskId } })).toBe(1)
  })

  it.each(['running', 'completed'])(
    'does not let a late failure overwrite a newer %s attempt',
    async (phase) => {
      const f = await fixture()
      let rejectOld!: (reason: Error) => void,
        finishNew!: (result: ReadBoundCommitEvidenceResult) => void
      let startedOld!: () => void, startedNew!: () => void
      const oldStarted = new Promise<void>((resolve) => {
        startedOld = resolve
      })
      const newStarted = new Promise<void>((resolve) => {
        startedNew = resolve
      })
      const read = vi
        .fn<BoundCommitEvidenceReader['read']>()
        .mockImplementationOnce(async () => {
          startedOld()
          return new Promise((_, reject) => {
            rejectOld = reject
          })
        })
        .mockImplementationOnce(async () => {
          startedNew()
          return new Promise((resolve) => {
            finishNew = resolve
          })
        })
      const processor = new GitHubEvidenceJobProcessor(database, { read })
      const old = processor.process(f.payload, firstAttempt)
      const oldFailure = expect(old).rejects.toMatchObject({ code: 'GITHUB_UNAVAILABLE' })
      await oldStarted
      const newer = processor.process(f.payload, { number: 2, maxAttempts: 3 })
      await newStarted
      if (phase === 'completed') {
        finishNew(f.collected)
        await newer
      }
      rejectOld(new GitHubEvidenceError('GITHUB_UNAVAILABLE'))
      await oldFailure
      expect(await f.savedDelivery()).toMatchObject({
        evidenceAttemptCount: 2,
        evidenceLastErrorCode: null,
        evidenceFailedAt: null,
      })
      if (phase === 'running') {
        finishNew(f.collected)
        await newer
      }
      expect(await f.savedDelivery()).toMatchObject({ status: 'PROCESSED' })
    },
  )
})

describe('R06 database write recovery', () => {
  it.each([
    {
      title: 'R06 observation: write retry',
      rejectedWrites: 1,
    },
    {
      title: 'stops after 3 rejected writes',
      rejectedWrites: 3,
    },
  ])('$title', async ({ rejectedWrites }) => {
    for (const url of [environment.DATABASE_URL, environment.REDIS_URL]) {
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
        throw new Error('Write recovery observation requires local test infrastructure')
    }
    const f = await fixture(true)
    const handoffRunIds: string[] = []
    const databaseErrors: (string | undefined)[] = []
    let injectedWrites = 0
    const faulty = database.$extends({
      query: {
        outboxEvent: {
          async create({ args, query }) {
            if (args.data.type !== 'NOTE_VERIFICATION_REQUESTED') return query(args)
            handoffRunIds.push(args.data.aggregateId)
            if (injectedWrites >= rejectedWrites) return query(args)
            injectedWrites += 1
            // 只对本夹具制造唯一键冲突，让 PostgreSQL 真正拒绝这条写入。
            // Task/Submission/Evidence/Run 已在同一事务内写过；不是数据库整机断连。
            try {
              return await query({
                ...args,
                data: { ...args.data, deduplicationKey: `github-push-received-${f.deliveryId}` },
              })
            } catch (error) {
              databaseErrors.push(
                error instanceof Prisma.PrismaClientKnownRequestError ? error.code : undefined,
              )
              throw error
            }
          },
        },
      },
    }) as DatabaseClient
    const inspect = async () => {
      const [delivery, task, submissions, evidence, runs, handoffOutbox] = await Promise.all([
        f.savedDelivery(),
        f.savedTask(),
        database.submission.count({ where: { taskId: f.taskId } }),
        database.evidence.count({ where: { submission: { taskId: f.taskId } } }),
        database.agentRun.count({ where: { taskId: f.taskId } }),
        database.outboxEvent.count({
          where: { type: 'NOTE_VERIFICATION_REQUESTED', aggregateId: { in: handoffRunIds } },
        }),
      ])
      return {
        delivery: delivery.status,
        attempts: delivery.evidenceAttemptCount,
        error: delivery.evidenceLastErrorCode,
        exhausted: delivery.evidenceFailedAt !== null,
        submissionId: delivery.submissionId,
        runId: delivery.agentRunId,
        task: task.state,
        taskVersion: task.version,
        submissions,
        evidence,
        runs,
        handoffOutbox,
      }
    }
    const before = await inspect()
    const failures: Awaited<ReturnType<typeof inspect>>[] = []
    const read = vi.fn<BoundCommitEvidenceReader['read']>().mockResolvedValue(f.collected)
    const processor = new GitHubEvidenceJobProcessor(faulty, { read })
    const processJob = vi.fn<GitHubEvidenceJobProcessor['process']>(async (payload, attempt) => {
      try {
        return await processor.process(payload, attempt)
      } catch (error) {
        // 在重新抛给 BullMQ、安排下一次尝试之前读取回滚后的真实数据库。
        failures.push(await inspect())
        throw error
      }
    })
    const { transport, inspector, events } = await queueFor({ process: processJob })
    const dispatcher = new OutboxDispatcher(
      database,
      { publish: vi.fn(), publishGitHubPush: (message) => transport.publish(message) },
      retryPolicy,
      () => new Date('2099-01-01T00:00:01Z'),
    )
    expect(await dispatcher.dispatchEvent(f.eventId)).toMatchObject({ status: 'DISPATCHED' })
    const originalEvent = await database.outboxEvent.findUniqueOrThrow({ where: { id: f.eventId } })
    expect(originalEvent.dispatchAttemptCount).toBe(1)
    const job = await inspector.getJob(buildGitHubEvidenceJobId(f.deliveryId))
    expect(job?.opts.attempts).toBe(3)
    transport.start()

    // 不再投递 Outbox、不手动 retry；允许次数内由真实 BullMQ 自动重新执行。
    const finished = job!.waitUntilFinished(events, 10_000)
    const recovers = rejectedWrites === 1
    if (recovers) await expect(finished).resolves.toMatchObject({ status: 'PROCESSED' })
    else await expect(finished).rejects.toThrow('EVIDENCE_PROCESSING_FAILED')

    expect(databaseErrors).toEqual(Array(rejectedWrites).fill('P2002'))
    expect(failures).toHaveLength(rejectedWrites)
    for (const [index, checkpoint] of failures.entries()) {
      expect(checkpoint).toEqual({
        ...before,
        attempts: index + 1,
        error: 'EVIDENCE_PROCESSING_FAILED',
        exhausted: index + 1 === 3,
      })
    }
    const attempts = recovers ? 2 : 3
    expect(processJob.mock.calls.map(([, attempt]) => attempt.number)).toEqual(
      Array.from({ length: attempts }, (_, index) => index + 1),
    )
    expect(read).toHaveBeenCalledTimes(attempts)
    const after = await inspect()
    if (recovers) {
      expect(after).toEqual({
        delivery: 'PROCESSED',
        attempts: 2,
        error: null,
        exhausted: false,
        submissionId: expect.any(String),
        runId: expect.any(String),
        task: 'VERIFYING',
        taskVersion: 4,
        submissions: 1,
        evidence: 1,
        runs: 1,
        handoffOutbox: 1,
      })
      expect(
        await database.agentRun.findUniqueOrThrow({ where: { id: after.runId! } }),
      ).toMatchObject({
        status: 'QUEUED',
        submissionId: after.submissionId,
        expectedTaskVersion: 4,
      })
    } else expect(after).toEqual(failures[2])
    expect(await job!.getState()).toBe(recovers ? 'completed' : 'failed')
    expect((await inspector.getJob(job!.id!))?.attemptsMade).toBe(attempts)
    expect(await database.outboxEvent.findUniqueOrThrow({ where: { id: f.eventId } })).toEqual(
      originalEvent,
    )
    if (recovers) {
      console.log({ event: 'handoff-rolled-back', ...failures[0] })
      console.log({
        event: 'handoff-recovered',
        job: await job!.getState(),
        attempts: after.attempts,
        taskVersion: after.taskVersion,
        runs: after.runs,
        handoffOutbox: after.handoffOutbox,
        outboxDispatchAttempts: originalEvent.dispatchAttemptCount,
      })
    }
  })
})

describe('R06 crash recovery', () => {
  it('R06 observation: recovers a worker crash after commit without repeating evidence or handoff', async () => {
    for (const url of [environment.DATABASE_URL, environment.REDIS_URL]) {
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
        throw new Error('Crash observation requires local test infrastructure')
    }
    // 原待办停放在未来；仅指定此 ID 的测试 Dispatcher 可投递，不让开发 Worker 认领夹具。
    const f = await fixture(true)
    const read = vi.fn<BoundCommitEvidenceReader['read']>().mockResolvedValue(f.collected)
    const processor = new GitHubEvidenceJobProcessor(database, { read })
    const { transport, inspector, events, queueName } = await queueFor(processor)
    const dispatcher = new OutboxDispatcher(
      database,
      { publish: vi.fn(), publishGitHubPush: (message) => transport.publish(message) },
      retryPolicy,
      () => new Date('2099-01-01T00:00:01Z'),
    )
    expect(await dispatcher.dispatchEvent(f.eventId)).toMatchObject({ status: 'DISPATCHED' })
    const originalEvent = await database.outboxEvent.findUniqueOrThrow({ where: { id: f.eventId } })
    const job = await inspector.getJob(buildGitHubEvidenceJobId(f.deliveryId))
    expect(await job!.getState()).toBe('waiting')

    // 只启动一个本测试拥有的进程；不按名称/PID 扫描或结束任何既有服务。
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('./fixtures/github-evidence-crash-worker.ts', import.meta.url)),
      ],
      {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        windowsHide: true,
        env: {
          DATABASE_URL: environment.DATABASE_URL,
          REDIS_URL: environment.REDIS_URL,
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
          ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
          ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
        },
      },
    )
    child.stderr?.resume() // 不向测试日志转发可能包含数据库细节的子进程错误。
    const exited = new Promise<void>((resolve) => child.once('close', () => resolve()))
    const stop = async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exited
    }
    resources.push(stop)
    const committed = new Promise<void>((resolve, reject) => {
      child.once('error', () => reject(new Error('Crash fixture could not start')))
      child.once('exit', () => reject(new Error('Crash fixture exited before checkpoint')))
      child.once('message', (message: unknown) => {
        if (
          typeof message === 'object' &&
          message !== null &&
          'event' in message &&
          message.event === 'committed-before-ack'
        )
          resolve()
        else reject(new Error('Crash fixture failed before checkpoint'))
      })
    })
    child.send({ queueName, payload: f.payload, collected: f.collected })
    await committed

    const deliveryBefore = await f.savedDelivery()
    const taskBefore = await f.savedTask()
    const submissionBefore = await database.submission.findUniqueOrThrow({
      where: { id: deliveryBefore.submissionId! },
      include: { evidence: true, runs: true },
    })
    const handoffBefore = await database.outboxEvent.findMany({
      where: { type: 'NOTE_VERIFICATION_REQUESTED', aggregateId: deliveryBefore.agentRunId! },
    })
    expect(deliveryBefore).toMatchObject({ status: 'PROCESSED', evidenceAttemptCount: 1 })
    expect(taskBefore).toMatchObject({ state: 'VERIFYING', version: 4 })
    expect(submissionBefore.evidence?.content).toBe('# Vue\nfixture\n')
    expect(submissionBefore.runs).toHaveLength(1)
    expect(submissionBefore.runs[0]).toMatchObject({ status: 'QUEUED' })
    expect(handoffBefore).toHaveLength(1)
    expect(await job!.getState()).toBe('active')
    console.log({ event: 'committed-before-ack', delivery: 'PROCESSED', job: 'active', runs: 1 })

    await stop()
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    expect(await job!.getState()).toBe('active')
    expect(await f.savedDelivery()).toEqual(deliveryBefore)
    console.log({ event: 'fixture-worker-exited', delivery: 'PROCESSED', job: 'active' })

    // 不重投 Webhook、重发 Outbox、手动 retry 或删除锁：由新 Worker 自己检查失联 Job。
    const stalled: string[] = []
    const workerErrors: string[] = []
    events.on('stalled', ({ jobId }) => stalled.push(jobId))
    const processAgain = vi.fn<GitHubEvidenceJobProcessor['process']>((payload, attempt) =>
      processor.process(payload, attempt),
    )
    const replacement = new Worker(
      queueName,
      createGitHubEvidenceBullMqProcessor({ process: processAgain }),
      {
        connection: bullMqWorkerConnection(environment.REDIS_URL),
        concurrency: 1,
        lockDuration: 1_500,
        stalledInterval: 100,
        maxStalledCount: 1,
      },
    )
    replacement.on('error', () => workerErrors.push('WORKER_ERROR'))
    resources.push(() => replacement.close(true))
    await replacement.waitUntilReady()
    await expect(job!.waitUntilFinished(events, 10_000)).resolves.toEqual({
      status: 'PROCESSED',
      submissionId: deliveryBefore.submissionId,
      runId: deliveryBefore.agentRunId,
    })
    expect(stalled).toContain(job!.id)
    expect(processAgain).toHaveBeenCalledTimes(1)
    expect(read).not.toHaveBeenCalled()
    expect(workerErrors).toEqual([])
    expect(await f.savedDelivery()).toEqual(deliveryBefore)
    expect(await f.savedTask()).toEqual(taskBefore)
    expect(await database.submission.count({ where: { taskId: f.taskId } })).toBe(1)
    expect(await database.agentRun.count({ where: { taskId: f.taskId } })).toBe(1)
    expect(
      await database.submission.findUniqueOrThrow({
        where: { id: deliveryBefore.submissionId! },
        include: { evidence: true, runs: true },
      }),
    ).toEqual(submissionBefore)
    expect(
      await database.outboxEvent.findMany({
        where: { type: 'NOTE_VERIFICATION_REQUESTED', aggregateId: deliveryBefore.agentRunId! },
      }),
    ).toEqual(handoffBefore)
    expect(await database.outboxEvent.findUniqueOrThrow({ where: { id: f.eventId } })).toEqual(
      originalEvent,
    )
    expect(await inspector.getJobCounts('wait', 'active', 'completed', 'failed')).toMatchObject({
      wait: 0,
      active: 0,
      completed: 1,
      failed: 0,
    })
    expect((await inspector.getJob(job!.id!))?.stalledCounter).toBe(1)
    console.log({
      event: 'recovered-from-saved-result',
      job: await job!.getState(),
      readerCalledAgain: read.mock.calls.length > 0,
      runs: await database.agentRun.count({ where: { taskId: f.taskId } }),
      taskVersion: (await f.savedTask()).version,
    })
  })
})

describe('R06 engineering closeout', () => {
  it.each([
    { checkpoint: 'before-commit' as const, crashes: 1, title: 'uncommitted exit recovers' },
    { checkpoint: 'before-commit' as const, crashes: 2, title: 'repeated exits reconcile failure' },
    {
      checkpoint: 'after-commit' as const,
      crashes: 2,
      title: 'failed queue never overrides committed success',
    },
  ])('$title', async ({ checkpoint, crashes }) => {
    const f = await fixture(true)
    const read = vi.fn<BoundCommitEvidenceReader['read']>().mockResolvedValue(f.collected)
    const processor = new GitHubEvidenceJobProcessor(database, { read })
    const { transport, inspector, events, queueName } = await queueFor(processor)
    await transport.publish(await f.message())
    const job = (await inspector.getJob(buildGitHubEvidenceJobId(f.deliveryId)))!
    const sourceBefore = await database.outboxEvent.findUniqueOrThrow({ where: { id: f.eventId } })
    for (let index = 0; index < crashes; index++) {
      const { stop } = await startCrashFixture(f, queueName, checkpoint)
      expect(await job.getState()).toBe('active')
      // 事务外读不到未提交结果；强杀之后也必须仍是零份。
      if (checkpoint === 'before-commit') {
        expect(await f.savedTask()).toMatchObject({ state: 'IN_PROGRESS', version: 3 })
        expect(await database.submission.count({ where: { taskId: f.taskId } })).toBe(0)
      }
      await stop()
    }
    const replacement = new Worker(queueName, createGitHubEvidenceBullMqProcessor(processor), {
      connection: bullMqWorkerConnection(environment.REDIS_URL),
      concurrency: 1,
      lockDuration: 1_500,
      stalledInterval: 100,
      maxStalledCount: 1,
    })
    const errors: string[] = []
    replacement.on('error', () => errors.push('WORKER_ERROR'))
    resources.push(() => replacement.close(true))
    await replacement.waitUntilReady()
    if (crashes === 1)
      await expect(job.waitUntilFinished(events, 10_000)).resolves.toMatchObject({
        status: 'PROCESSED',
      })
    else await expect(job.waitUntilFinished(events, 10_000)).rejects.toThrow('stalled')
    const savedJob = (await inspector.getJob(job.id!))!
    const reconciler = reconcilerFor(database, transport, f.deliveryId)
    expect(await reconciler.reconcile(10)).toBe(
      checkpoint === 'before-commit' && crashes === 2 ? 1 : 0,
    )
    expect(await reconciler.reconcile(10)).toBe(0)
    const succeeded = crashes === 1 || checkpoint === 'after-commit'
    expect(await f.savedDelivery()).toMatchObject({
      status: succeeded ? 'PROCESSED' : 'ACCEPTED',
      evidenceFailedAt: succeeded ? null : expect.any(Date),
      evidenceLastErrorCode: succeeded ? null : 'EVIDENCE_PROCESSING_FAILED',
    })
    expect(await f.savedTask()).toMatchObject({
      state: succeeded ? 'VERIFYING' : 'IN_PROGRESS',
      version: succeeded ? 4 : 3,
    })
    const runs = await database.agentRun.findMany({ where: { taskId: f.taskId } })
    expect(runs).toHaveLength(succeeded ? 1 : 0)
    expect(await database.submission.count({ where: { taskId: f.taskId } })).toBe(succeeded ? 1 : 0)
    expect(await database.evidence.count({ where: { submission: { taskId: f.taskId } } })).toBe(
      succeeded ? 1 : 0,
    )
    if (succeeded) {
      expect(runs[0]?.status).toBe('QUEUED')
      expect(await database.outboxEvent.count({ where: { aggregateId: runs[0]!.id } })).toBe(1)
    }
    expect(read).toHaveBeenCalledTimes(crashes === 1 ? 1 : 0)
    expect(await database.outboxEvent.findUniqueOrThrow({ where: { id: f.eventId } })).toEqual(
      sourceBefore,
    )
    expect(errors).toEqual([])
    console.log({
      event: 'closeout-exit',
      checkpoint,
      crashes,
      queue: await savedJob.getState(),
      delivery: (await f.savedDelivery()).status,
      runs: runs.length,
    })
  })

  it.each(['transient', 'exhausted', 'before-start'] as const)(
    'database connection loss: %s',
    async (mode) => {
      const f = await fixture(true)
      const gate = await postgresConnectionGate(environment.DATABASE_URL)
      const isolated = createDatabaseClient(gate.url)
      resources.push(async () => {
        await isolated.$disconnect()
        await gate.close()
      })
      let failedErrorWrites = 0
      const faulty = isolated.$extends({
        query: {
          webhookDelivery: {
            async updateMany({ args, query }) {
              try {
                return await query(args)
              } catch (error) {
                failedErrorWrites++
                throw error
              }
            },
          },
        },
      }) as DatabaseClient
      const read = vi.fn<BoundCommitEvidenceReader['read']>().mockImplementation(async () => {
        if (read.mock.calls.length === 1 && mode !== 'before-start') gate.block()
        return f.collected
      })
      const processor = new GitHubEvidenceJobProcessor(faulty, { read })
      const processJob = vi.fn<GitHubEvidenceJobProcessor['process']>(async (payload, attempt) => {
        try {
          return await processor.process(payload, attempt)
        } catch (error) {
          if (mode === 'transient') gate.restore()
          throw error
        }
      })
      const { transport, inspector, events } = await queueFor({ process: processJob })
      await transport.publish(await f.message())
      const job = (await inspector.getJob(buildGitHubEvidenceJobId(f.deliveryId)))!
      if (mode === 'before-start') gate.block()
      transport.start()
      if (mode === 'transient') {
        await expect(job.waitUntilFinished(events, 10_000)).resolves.toMatchObject({
          status: 'PROCESSED',
        })
        expect(failedErrorWrites).toBe(1)
        expect(read).toHaveBeenCalledTimes(2)
      } else {
        await expect(job.waitUntilFinished(events, 10_000)).rejects.toThrow(
          'EVIDENCE_PROCESSING_FAILED',
        )
        expect(failedErrorWrites).toBe(mode === 'exhausted' ? 1 : 0)
        expect(await f.savedDelivery()).toMatchObject({
          status: 'ACCEPTED',
          evidenceFailedAt: null,
          evidenceAttemptCount: mode === 'before-start' ? 0 : 1,
        })
        expect(await database.agentRun.count({ where: { taskId: f.taskId } })).toBe(0)
        const reconcile = reconcilerFor(faulty, transport, f.deliveryId)
        // 对账本身也遭遇真实连接失败；恢复连接后重建实例，证明无需内存事件。
        await expect(reconcile.reconcile(10)).rejects.toThrow()
        gate.restore()
        expect(await reconcilerFor(faulty, transport, f.deliveryId).reconcile(10)).toBe(1)
        const failed = await f.savedDelivery()
        const queued = (await inspector.getJob(job.id!))!
        expect(failed).toMatchObject({
          evidenceAttemptCount: queued.attemptsStarted,
          evidenceLastErrorCode: 'EVIDENCE_PROCESSING_FAILED',
          evidenceFailedAt: expect.any(Date),
        })
        expect(queued.attemptsStarted).toBe(3)
        const visible = await new RepositoryEvidenceService({
          client: database,
        } as DatabaseService).list(f.userId, f.binding.repositoryId)
        expect(visible.deliveries).toEqual([
          expect.objectContaining({
            deliveryId: f.deliveryId,
            status: 'FAILED',
            canRetry: true,
            attemptCount: 3,
          }),
        ])
        // 原权限/版本检查与手动恢复协议不变，包括从“数据库从未记录开始”恢复。
        const recovery = new RepositoryEvidenceRetryService(
          { client: database },
          () => new Date('2099-01-01T00:00:00Z'),
        )
        let accepted = await recovery.retry(f.userId, f.binding.repositoryId, f.deliveryId, {
          expectedAttemptCount: 3,
        })
        const dispatch = new OutboxDispatcher(
          database,
          { publish: vi.fn(), publishGitHubEvidenceRetry: (message) => transport.publish(message) },
          retryPolicy,
          () => new Date('2099-01-01T00:00:01Z'),
        )
        if (mode === 'before-start') {
          // 第一轮手动恢复又在开始登记前断连；累计版本必须前进，第二次点击不能卡回旧请求。
          gate.block()
          await dispatch.dispatchEvent(accepted.retryEventId)
          const retryJob = (await inspector.getJob(
            buildGitHubEvidenceJobId(f.deliveryId, accepted.retryEventId),
          ))!
          await expect(retryJob.waitUntilFinished(events, 10_000)).rejects.toThrow()
          gate.restore()
          expect(await reconcilerFor(faulty, transport, f.deliveryId).reconcile(10)).toBe(1)
          expect((await f.savedDelivery()).evidenceAttemptCount).toBe(6)
          const second = await recovery.retry(f.userId, f.binding.repositoryId, f.deliveryId, {
            expectedAttemptCount: 6,
          })
          expect(second.retryEventId).not.toBe(accepted.retryEventId)
          accepted = second
        }
        await dispatch.dispatchEvent(accepted.retryEventId)
        const retryJob = (await inspector.getJob(
          buildGitHubEvidenceJobId(f.deliveryId, accepted.retryEventId),
        ))!
        await expect(retryJob.waitUntilFinished(events, 10_000)).resolves.toMatchObject({
          status: 'PROCESSED',
        })
      }
      expect(await f.savedDelivery()).toMatchObject({ status: 'PROCESSED', evidenceFailedAt: null })
      expect(await f.savedTask()).toMatchObject({ state: 'VERIFYING', version: 4 })
      expect(await database.agentRun.count({ where: { taskId: f.taskId } })).toBe(1)
      console.log({
        event: 'closeout-database',
        mode,
        failedErrorWrites,
        delivery: (await f.savedDelivery()).status,
        runs: 1,
      })
    },
  )

  it.each(['success', 'new-attempt', 'new-retry'] as const)(
    'reconciliation cannot overwrite a concurrent %s',
    async (mode) => {
      const f = await fixture(true)
      const processor = new GitHubEvidenceJobProcessor(database, { read: async () => f.collected })
      const { transport, inspector, events } = await queueFor({
        process: async () => {
          throw new Error('fixture failure')
        },
      })
      await transport.publish(await f.message())
      transport.start()
      const job = (await inspector.getJob(buildGitHubEvidenceJobId(f.deliveryId)))!
      await expect(job.waitUntilFinished(events, 10_000)).rejects.toThrow()
      const lookup = transport.getFailure.bind(transport)
      let expected: Awaited<ReturnType<typeof f.savedDelivery>> | undefined
      const spy = vi.spyOn(transport, 'getFailure').mockImplementation(async (payload) => {
        const failed = await lookup(payload)
        if (mode === 'success') await processor.process(f.payload, firstAttempt)
        else
          await database.webhookDelivery.update({
            where: { id: f.deliveryId },
            data:
              mode === 'new-attempt'
                ? { evidenceAttemptCount: { increment: 1 }, evidenceLastAttemptAt: new Date() }
                : { evidenceRetryEventId: randomUUID() },
          })
        expected = await f.savedDelivery()
        return failed
      })
      try {
        expect(await reconcilerFor(database, transport, f.deliveryId).reconcile(10)).toBe(0)
        expect(await f.savedDelivery()).toEqual(expected)
      } finally {
        spy.mockRestore()
      }
    },
  )
})

describe('R06 Dispatcher → real BullMQ → evidence consumer', () => {
  it('queues while the consumer is stopped, deduplicates a lost acknowledgement, and completes on start', async () => {
    const f = await fixture()
    const read = vi.fn<BoundCommitEvidenceReader['read']>().mockResolvedValue(f.collected)
    const { transport, inspector, events } = await queueFor(
      new GitHubEvidenceJobProcessor(database, { read }),
    )
    let first = true,
      now = new Date()
    const dispatcher = new OutboxDispatcher(
      database,
      {
        publish: vi.fn(),
        publishGitHubPush: async (message) => {
          const result = await transport.publish(message)
          if (first) {
            first = false
            throw new Error('fixture: acknowledgement lost after enqueue')
          }
          return result
        },
      },
      retryPolicy,
      () => now,
    )
    await expect(dispatcher.dispatchEvent(f.eventId)).resolves.toMatchObject({
      status: 'RETRY_SCHEDULED',
    })
    now = new Date(now.getTime() + 1_000)
    await expect(dispatcher.dispatchEvent(f.eventId)).resolves.toMatchObject({
      status: 'DISPATCHED',
    })
    const job = await inspector.getJob(buildGitHubEvidenceJobId(f.deliveryId))
    expect(job?.data).toEqual(f.payload)
    expect(await inspector.getJobCounts('wait')).toMatchObject({ wait: 1 })
    expect(read).not.toHaveBeenCalled()
    transport.start()
    await expect(job!.waitUntilFinished(events, 10_000)).resolves.toMatchObject({
      status: 'PROCESSED',
    })
    expect(read).toHaveBeenCalledTimes(1)
    const saved = await f.savedDelivery()
    const note = await database.outboxEvent.findFirstOrThrow({
      where: { type: 'NOTE_VERIFICATION_REQUESTED', aggregateId: saved.agentRunId! },
    })
    await expect(dispatcher.dispatchEvent(note.id)).resolves.toEqual({ status: 'EMPTY' })
    expect(
      await database.agentRun.findUniqueOrThrow({ where: { id: saved.agentRunId! } }),
    ).toMatchObject({ status: 'QUEUED' })
  })

  it('automatically retries a transient read failure and creates only one handoff', async () => {
    const f = await fixture()
    const read = vi
      .fn<BoundCommitEvidenceReader['read']>()
      .mockRejectedValueOnce(new GitHubEvidenceError('GITHUB_UNAVAILABLE'))
      .mockResolvedValue(f.collected)
    const { transport, inspector, events } = await queueFor(
      new GitHubEvidenceJobProcessor(database, { read }),
    )
    await transport.publish(await f.message())
    const job = await inspector.getJob(buildGitHubEvidenceJobId(f.deliveryId))
    transport.start()
    await expect(job!.waitUntilFinished(events, 10_000)).resolves.toMatchObject({
      status: 'PROCESSED',
    })
    expect(await f.savedDelivery()).toMatchObject({
      status: 'PROCESSED',
      evidenceAttemptCount: 2,
      evidenceLastErrorCode: null,
    })
    expect(await database.agentRun.count({ where: { taskId: f.taskId } })).toBe(1)
  })

  it.each([
    ['GITHUB_AUTH_REQUIRED', 1],
    ['GITHUB_UNAVAILABLE', 3],
  ] as const)(
    'retains %s failure after %s attempts without a fictitious AgentRun',
    async (code, attempts) => {
      const f = await fixture()
      const read = vi
        .fn<BoundCommitEvidenceReader['read']>()
        .mockRejectedValue(new GitHubEvidenceError(code))
      const { transport, inspector, events } = await queueFor(
        new GitHubEvidenceJobProcessor(database, { read }),
      )
      await transport.publish(await f.message())
      const job = await inspector.getJob(buildGitHubEvidenceJobId(f.deliveryId))
      transport.start()
      await expect(job!.waitUntilFinished(events, 10_000)).rejects.toThrow(code)
      expect(await job!.getState()).toBe('failed')
      expect(read).toHaveBeenCalledTimes(attempts)
      expect(await f.savedDelivery()).toMatchObject({
        status: 'ACCEPTED',
        evidenceAttemptCount: attempts,
        evidenceLastErrorCode: code,
        evidenceFailedAt: expect.any(Date),
        agentRunId: null,
      })
      expect(await f.savedTask()).toMatchObject({ state: 'IN_PROGRESS', version: 3 })
      // 只对本测试的失败 Job 模拟运维修复后显式重试，不是重复 Webhook 自动复活失败任务。
      read.mockResolvedValue(f.collected)
      await job!.retry('failed', { resetAttemptsMade: true, resetAttemptsStarted: true })
      await expect(job!.waitUntilFinished(events, 10_000)).resolves.toMatchObject({
        status: 'PROCESSED',
      })
      expect(await f.savedDelivery()).toMatchObject({
        evidenceAttemptCount: attempts + 1,
        evidenceLastErrorCode: null,
        evidenceFailedAt: null,
      })
      expect(await database.agentRun.count({ where: { taskId: f.taskId } })).toBe(1)
    },
  )

  it('dead-letters a legacy intake instead of filling its context with the current task', async () => {
    const f = await fixture()
    await database.outboxEvent.update({ where: { id: f.eventId }, data: { schemaVersion: 1 } })
    const publishGitHubPush = vi.fn()
    const dispatcher = new OutboxDispatcher(
      database,
      { publish: vi.fn(), publishGitHubPush },
      retryPolicy,
    )
    await expect(dispatcher.dispatchEvent(f.eventId)).resolves.toMatchObject({
      status: 'DEAD_LETTERED',
      failure: { code: 'OUTBOX_SCHEMA_VERSION_UNSUPPORTED' },
    })
    expect(publishGitHubPush).not.toHaveBeenCalled()
    expect(await f.savedDelivery()).toMatchObject({ evidenceAttemptCount: 0 })
  })
})
