import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import { createDatabaseClient, type DatabaseClient } from '@knowledgeops/database'
import { retryNoteVerificationResponseSchema } from '@knowledgeops/contracts'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module.js'
import { API_ENVIRONMENT } from '../src/config/config.module.js'
import { readApiEnvironment } from '../src/config/environment.js'
import { DatabaseService } from '../src/database/database.service.js'
import { hashToken, opaqueToken } from '../src/identity/auth-http.js'
import {
  createNoteVerificationFixture,
  type NoteFixtureIdentity,
} from '../../worker/test/fixtures/verification.js'
import { readWorkerEnvironment } from '../../worker/src/config/environment.js'
import { NoteVerificationRunRepository } from '../../worker/src/verification/note-verification-run.repository.js'
import { NoteVerificationExecutionRepository } from '../../worker/src/verification/note-verification-execution.repository.js'
import { NoteVerificationJobProcessor } from '../../worker/src/verification/note-verification-job-processor.js'

if (
  !process.env.DATABASE_URL ||
  !['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname)
)
  throw new Error('R15 integration requires a local DATABASE_URL')
const environment = readApiEnvironment({
  DATABASE_URL: process.env.DATABASE_URL,
  NODE_ENV: 'test',
  WEB_ORIGIN: 'http://127.0.0.1:3000',
})
const fixtures: NoteFixtureIdentity[] = []
let rejectOutbox = false
const database = createDatabaseClient(environment.DATABASE_URL).$extends({
  query: {
    outboxEvent: {
      create({ args, query }) {
        if (rejectOutbox) throw new Error('fixture-private-outbox-error')
        // 随机夹具不会被真实 Dispatcher 领取。
        return query({ ...args, data: { ...args.data, availableAt: new Date('2099-01-01') } })
      },
    },
  },
}) as unknown as DatabaseClient
const workerEnvironment = readWorkerEnvironment({
  ...process.env,
  OPENAI_API_KEY: 'fixture',
  NOTE_VERIFICATION_TIMEOUT_MS: '30000',
  NOTE_VERIFICATION_MODEL_JSON: JSON.stringify({
    catalogId: 'fixture',
    modelName: 'fixture',
    currency: 'CNY',
    inputMicrounitsPerMillionTokens: 8_000_000,
    outputMicrounitsPerMillionTokens: 28_000_000,
  }),
})
const usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 }
const processor = new NoteVerificationJobProcessor(
  new NoteVerificationRunRepository(database, workerEnvironment),
  new NoteVerificationExecutionRepository(database),
  {
    verify: async (request) => ({
      usage,
      candidate: {
        results: request.criteria.map((c) => ({
          criterionId: c.id,
          outcome: 'PASSED',
          rationale: '合成验收',
          suggestions: [],
          confidence: 0.8,
          citations: [{ startLine: 3, endLine: 3, excerpt: request.note.lines[2]! }],
        })),
      },
    }),
  },
  {
    generate: async (request) => ({
      usage,
      candidate: {
        question: '为什么要先清空微任务队列？',
        rubric: ['解释事件循环顺序'],
        citations: [{ startLine: 3, endLine: 3, excerpt: request.note.lines[2]! }],
      },
    }),
  },
)
let f: Awaited<ReturnType<typeof createNoteVerificationFixture>>, token: string
let app: INestApplication, baseUrl: string
const headers = () => ({
  cookie: `knowledgeops_session=${token}`,
  origin: environment.WEB_ORIGIN,
  'content-type': 'application/json',
})
const post = (
  body: unknown = { expectedRunVersion: 1, expectedTaskVersion: 7 },
  id = f.runId,
  requestHeaders = headers(),
) =>
  fetch(`${baseUrl}/agent-runs/${id}/retry`, {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify(body),
  })
async function accepted(body?: unknown, id?: string) {
  const response = await post(body, id)
  expect(response.status).toBe(202)
  return retryNoteVerificationResponseSchema.parse(await response.json())
}
beforeAll(async () => {
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(API_ENVIRONMENT)
    .useValue(environment)
    .overrideProvider(DatabaseService)
    .useValue({ client: database })
    .compile()
  app = module.createNestApplication({ logger: false })
  await app.listen(0, '127.0.0.1')
  baseUrl = await app.getUrl()
})
beforeEach(async () => {
  rejectOutbox = false
  f = await createNoteVerificationFixture(database, (value) => fixtures.push(value))
  await database.user.update({
    where: { id: f.userId },
    data: { githubLogin: 'r15-retry-fixture' },
  })
  token = opaqueToken()
  await database.session.create({
    data: {
      tokenHash: hashToken(token),
      userId: f.userId,
      expiresAt: new Date(Date.now() + 300_000),
    },
  })
  await database.agentRun.update({
    where: { id: f.runId },
    data: { status: 'FAILED', version: 1, finishedAt: new Date(), errorCode: 'MODEL_TIMEOUT' },
  })
  await database.task.update({
    where: { id: f.taskId },
    data: { state: 'IN_PROGRESS', version: 7 },
  })
})
afterEach(async () => {
  rejectOutbox = false
  for (const fixture of fixtures.splice(0).reverse()) {
    const ids = (
      await database.agentRun.findMany({ where: { taskId: fixture.taskId }, select: { id: true } })
    ).map((r) => r.id)
    await database.outboxEvent.deleteMany({ where: { aggregateId: { in: ids } } })
    await database.agentRun.deleteMany({ where: { taskId: fixture.taskId } })
    await database.submission.deleteMany({ where: { taskId: fixture.taskId } })
    await database.user.deleteMany({ where: { id: fixture.userId } })
    await database.gitHubInstallation.deleteMany({ where: { id: fixture.installationId } })
  }
})
afterAll(async () => {
  await app?.close()
  await database.$disconnect()
})

describe('R15 linked note verification retry', () => {
  it.each(['FAILED', 'TIMED_OUT', 'CANCELLED'] as const)(
    'creates a fresh Run for %s and atomically moves Task with its Outbox',
    async (status) => {
      await database.agentRun.update({
        where: { id: f.runId },
        data: {
          status,
          executionConfiguration: { fixture: 'exhausted-old-budget' },
          deadlineAt: new Date('2026-01-01'),
        },
      })
      const before = await f.run()
      const result = await accepted()
      expect(result).toMatchObject({ taskId: f.taskId, retryOfRunId: f.runId, taskVersion: 8 })
      const child = await database.agentRun.findUniqueOrThrow({
        where: { id: result.runId },
        include: { modelExecution: true },
      })
      expect(child).toMatchObject({
        submissionId: f.submissionId,
        status: 'QUEUED',
        version: 0,
        retryOfRunId: f.runId,
        expectedTaskVersion: 8,
        taskStateBeforeRun: 'IN_PROGRESS',
        executionConfiguration: null,
        deadlineAt: null,
        modelExecution: null,
      })
      expect(await f.task()).toMatchObject({ state: 'VERIFYING', version: 8 })
      expect(await processor.process(f.payload)).toMatchObject({ status })
      expect(await f.task()).toMatchObject({ state: 'VERIFYING', version: 8 })
      expect(await f.run()).toEqual(before)
      expect(await database.submission.count({ where: { taskId: f.taskId } })).toBe(1)
      expect(
        await database.outboxEvent.findUniqueOrThrow({
          where: { deduplicationKey: `note-verification-retry-${f.runId}` },
        }),
      ).toMatchObject({
        aggregateId: child.id,
        type: 'NOTE_VERIFICATION_REQUESTED',
        payload: { runId: child.id, submissionId: f.submissionId },
      })
    },
  )

  it('returns one successor for concurrent clicks, refresh and replay even after that successor finishes', async () => {
    const results = await Promise.all([accepted(), accepted(), accepted()])
    expect(new Set(results.map((r) => r.runId)).size).toBe(1)
    const child = results[0]!
    expect(
      await processor.process({ runId: child.runId, submissionId: f.submissionId }),
    ).toMatchObject({ status: 'SUCCEEDED' })
    expect(await accepted({ expectedRunVersion: 1, expectedTaskVersion: 9 })).toEqual(child)
    const source = await fetch(`${baseUrl}/agent-runs/${f.runId}`, { headers: headers() })
    expect(await source.json()).toMatchObject({ status: 'FAILED', retryRunId: child.runId })
    const current = await fetch(`${baseUrl}/agent-runs/${child.runId}`, { headers: headers() })
    expect(await current.json()).toMatchObject({
      status: 'SUCCEEDED',
      retryOfRunId: f.runId,
      report: { body: { followUp: { status: 'READY' } } },
    })
    expect(await database.agentRun.count({ where: { taskId: f.taskId } })).toBe(2)
  })

  it('retries a failed successor as a chain, never a second branch from the original Run', async () => {
    const child = await accepted()
    await database.agentRun.update({
      where: { id: child.runId },
      data: { status: 'TIMED_OUT', version: 1, finishedAt: new Date() },
    })
    await database.task.update({
      where: { id: f.taskId },
      data: { state: 'IN_PROGRESS', version: 9 },
    })
    const next = await accepted({ expectedRunVersion: 1, expectedTaskVersion: 9 }, child.runId)
    expect(next.retryOfRunId).toBe(child.runId)
    expect(await accepted()).toEqual(child)
    expect(await f.task()).toMatchObject({ version: 10, state: 'VERIFYING' })
  })

  it('rolls back the new Run and Task when Outbox creation fails', async () => {
    rejectOutbox = true
    const response = await post()
    expect(response.status).toBe(500)
    expect(JSON.stringify(await response.json())).not.toContain('fixture-private')
    expect(await f.task()).toMatchObject({ state: 'IN_PROGRESS', version: 7 })
    expect(await database.agentRun.count({ where: { taskId: f.taskId } })).toBe(1)
    rejectOutbox = false
    await accepted()
  })

  it.each(['SUCCEEDED', 'RUNNING', 'QUEUED', 'CANCEL_REQUESTED'] as const)(
    'rejects source status %s without creating a retry',
    async (status) => {
      await database.agentRun.update({ where: { id: f.runId }, data: { status } })
      expect((await post()).status).toBe(409)
      expect(await database.agentRun.count({ where: { taskId: f.taskId } })).toBe(1)
    },
  )

  it.each([
    'run-version',
    'task-version',
    'new-task',
    'passed',
    'inactive-plan',
    'unbound',
    'path',
    'new-submission',
    'busy',
  ])('rejects changed context: %s', async (change) => {
    if (change === 'new-task')
      await database.task.update({ where: { id: f.taskId }, data: { version: 8 } })
    if (change === 'passed')
      await database.task.update({ where: { id: f.taskId }, data: { state: 'PASSED' } })
    if (change === 'unbound')
      await database.repository.update({ where: { id: f.repositoryId }, data: { enabled: false } })
    if (change === 'path')
      await database.task.update({ where: { id: f.taskId }, data: { targetPath: 'notes/new.md' } })
    if (change === 'inactive-plan') {
      const stage = await database.stage.findUniqueOrThrow({
        where: { id: (await f.task()).stageId },
      })
      await database.plan.update({ where: { id: stage.planId }, data: { status: 'ARCHIVED' } })
    }
    if (change === 'new-submission') {
      const note = await database.submission.findUniqueOrThrow({ where: { id: f.submissionId } })
      await database.submission.create({
        data: { ...note, id: randomUUID(), taskVersion: 7, afterCommitSha: 'c'.repeat(40) },
      })
    }
    if (change === 'busy')
      await database.agentRun.create({
        data: {
          taskId: f.taskId,
          kind: 'NOTE_VERIFICATION',
          expectedTaskVersion: 8,
          taskStateBeforeRun: 'IN_PROGRESS',
          workflowVersion: 'note-v1',
        },
      })
    const response = await post({
      expectedRunVersion: change === 'run-version' ? 0 : 1,
      expectedTaskVersion: change === 'task-version' ? 6 : change === 'new-task' ? 8 : 7,
    })
    expect(response.status).toBe(409)
    expect(await database.agentRun.count({ where: { retryOfRunId: f.runId } })).toBe(0)
  })

  it('requires authenticated ownership, same Origin and strict input', async () => {
    expect((await post(undefined, f.runId, { ...headers(), cookie: '' })).status).toBe(401)
    expect(
      (await post(undefined, f.runId, { ...headers(), origin: 'https://other.example' })).status,
    ).toBe(403)
    const other = await createNoteVerificationFixture(database, (value) => fixtures.push(value))
    expect((await post(undefined, other.runId)).status).toBe(404)
    expect((await post(undefined, randomUUID())).status).toBe(404)
    expect(
      (await post({ expectedTaskVersion: 7, expectedRunVersion: 1, submissionId: randomUUID() }))
        .status,
    ).toBe(400)
    expect((await post({ expectedRunVersion: -1 })).status).toBe(400)
  })
})
