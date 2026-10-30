import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import { createDatabaseClient, type DatabaseClient } from '@knowledgeops/database'
import {
  retryAnswerVerificationResponseSchema,
  followUpAnswerResponseSchema,
} from '@knowledgeops/contracts'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppModule } from '../src/app.module.js'
import { API_ENVIRONMENT } from '../src/config/config.module.js'
import { readApiEnvironment } from '../src/config/environment.js'
import { DatabaseService } from '../src/database/database.service.js'
import { hashToken, opaqueToken } from '../src/identity/auth-http.js'
import { FollowUpAnswerService } from '../src/verification/follow-up-answer.service.js'
import {
  createNoteVerificationFixture,
  type NoteFixtureIdentity,
} from '../../worker/test/fixtures/verification.js'
import { readWorkerEnvironment } from '../../worker/src/config/environment.js'
import { NoteVerificationRunRepository } from '../../worker/src/verification/note-verification-run.repository.js'
import {
  NoteVerificationExecutionRepository,
  VerificationExecutionRepository,
} from '../../worker/src/verification/note-verification-execution.repository.js'
import { NoteVerificationJobProcessor } from '../../worker/src/verification/note-verification-job-processor.js'
import { AnswerVerificationRunRepository } from '../../worker/src/verification/answer-verification-run.repository.js'
import { AnswerVerificationJobProcessor } from '../../worker/src/verification/answer-verification-job-processor.js'
import { answerExecutionResultSchema } from '../../worker/src/verification/execute-persisted-answer-verification.js'

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
const noteProcessor = new NoteVerificationJobProcessor(
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
        question: '为什么先清空微任务？',
        rubric: ['说明微任务会清空'],
        citations: [{ startLine: 3, endLine: 3, excerpt: request.note.lines[2]! }],
      },
    }),
  },
)
const verify = vi.fn(
  async (
    request: Parameters<
      ConstructorParameters<typeof AnswerVerificationJobProcessor>[2]['verify']
    >[0],
  ) => ({
    usage,
    candidate: {
      outcome: 'PASSED' as const,
      rationale: '合成判断',
      suggestions: [],
      confidence: 0.8,
      citations: [{ startLine: 3, endLine: 3, excerpt: request.note.lines[2]! }],
      answerCitations: [{ startLine: 1, endLine: 1, excerpt: request.answer.content }],
    },
  }),
)
const processor = new AnswerVerificationJobProcessor(
  new AnswerVerificationRunRepository(database, workerEnvironment),
  new VerificationExecutionRepository(database, 'ANSWER_VERIFICATION', answerExecutionResultSchema),
  { verify },
)
let f: Awaited<ReturnType<typeof createNoteVerificationFixture>>, token: string
let original: Awaited<ReturnType<FollowUpAnswerService['submit']>>, questionId: string
let app: INestApplication, baseUrl: string
const headers = () => ({
  cookie: `knowledgeops_session=${token}`,
  origin: environment.WEB_ORIGIN,
  'content-type': 'application/json',
})
const post = (
  body: unknown = { expectedRunVersion: 1, expectedTaskVersion: 9 },
  runId = original.runId,
  answerId = original.answerSubmissionId,
  requestHeaders = headers(),
) =>
  fetch(`${baseUrl}/answer-submissions/${answerId}/runs/${runId}/retry`, {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify(body),
  })
async function accepted(body?: unknown, runId?: string) {
  const response = await post(body, runId)
  expect(response.status).toBe(202)
  return retryAnswerVerificationResponseSchema.parse(await response.json())
}
const get = (runId?: string, answerId = original.answerSubmissionId) =>
  fetch(`${baseUrl}/answer-submissions/${answerId}${runId ? `?runId=${runId}` : ''}`, {
    headers: headers(),
  })
const run = (id = original.runId) =>
  database.agentRun.findUniqueOrThrow({
    where: { id },
    include: { modelExecution: true, report: true },
  })
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
  verify.mockClear()
  f = await createNoteVerificationFixture(database, (value) => fixtures.push(value))
  await database.user.update({ where: { id: f.userId }, data: { githubLogin: 'r15-answer-retry' } })
  token = opaqueToken()
  await database.session.create({
    data: {
      tokenHash: hashToken(token),
      userId: f.userId,
      expiresAt: new Date(Date.now() + 300_000),
    },
  })
  const report = await noteProcessor.process(f.payload)
  const question = await database.followUpQuestion.findUniqueOrThrow({
    where: { reportId: report.reportId! },
  })
  questionId = question.id
  original = await new FollowUpAnswerService(database).submit(f.userId, questionId, {
    requestId: randomUUID(),
    expectedTaskVersion: (await f.task()).version,
    answer: '微任务队列清空后才进入下一宏任务。',
  })
  await database.agentRun.update({
    where: { id: original.runId },
    data: { status: 'FAILED', version: 1, finishedAt: new Date(), errorCode: 'MODEL_TIMEOUT' },
  })
  await database.task.update({
    where: { id: f.taskId },
    data: { state: 'NEEDS_EVIDENCE', version: original.taskVersion + 1 },
  })
})
afterEach(async () => {
  rejectOutbox = false
  for (const item of fixtures.splice(0).reverse()) {
    const ids = (
      await database.agentRun.findMany({ where: { taskId: item.taskId }, select: { id: true } })
    ).map((r) => r.id)
    await database.outboxEvent.deleteMany({ where: { aggregateId: { in: ids } } })
    await database.agentRun.deleteMany({
      where: { taskId: item.taskId, kind: 'ANSWER_VERIFICATION' },
    })
    await database.answerSubmission.deleteMany({
      where: { question: { report: { run: { taskId: item.taskId } } } },
    })
    await database.agentRun.deleteMany({ where: { taskId: item.taskId } })
    await database.submission.deleteMany({ where: { taskId: item.taskId } })
    await database.user.deleteMany({ where: { id: item.userId } })
    await database.gitHubInstallation.deleteMany({ where: { id: item.installationId } })
  }
})
afterAll(async () => {
  await app?.close()
  await database.$disconnect()
})

describe('R15 linked answer verification retry', () => {
  it.each(['FAILED', 'TIMED_OUT', 'CANCELLED'] as const)(
    'reuses the saved answer after %s with a fresh Run and budget',
    async (status) => {
      await database.agentRun.update({
        where: { id: original.runId },
        data: {
          status,
          executionConfiguration: { fixture: 'exhausted' },
          deadlineAt: new Date('2026-01-01'),
        },
      })
      const before = await run()
      const saved = await database.answerSubmission.findUniqueOrThrow({
        where: { id: original.answerSubmissionId },
      })
      const child = await accepted()
      expect(child).toMatchObject({
        answerSubmissionId: saved.id,
        retryOfRunId: original.runId,
        taskVersion: 10,
      })
      expect(await run(child.runId)).toMatchObject({
        status: 'QUEUED',
        version: 0,
        answerSubmissionId: saved.id,
        submissionId: null,
        retryOfRunId: original.runId,
        expectedTaskVersion: 10,
        executionConfiguration: null,
        deadlineAt: null,
        modelExecution: null,
      })
      expect(await f.task()).toMatchObject({ state: 'VERIFYING', version: 10 })
      expect(
        await processor.process({ runId: original.runId, answerSubmissionId: saved.id }),
      ).toMatchObject({ status })
      expect(await run()).toEqual(before)
      expect(await f.task()).toMatchObject({ state: 'VERIFYING', version: 10 })
      expect(await database.answerSubmission.findUnique({ where: { id: saved.id } })).toEqual(saved)
      expect(await database.answerSubmission.count({ where: { questionId } })).toBe(1)
      expect(
        await database.outboxEvent.findUnique({
          where: { deduplicationKey: `answer-verification-retry-${original.runId}` },
        }),
      ).toMatchObject({
        type: 'ANSWER_VERIFICATION_REQUESTED',
        aggregateId: child.runId,
        payload: { runId: child.runId, answerSubmissionId: saved.id },
      })
    },
  )

  it('deduplicates concurrent commands and lets the original processor finalize a separately selected result', async () => {
    const results = await Promise.all([accepted(), accepted(), accepted()])
    expect(new Set(results.map((r) => r.runId)).size).toBe(1)
    const child = results[0]!
    const message = { runId: child.runId, answerSubmissionId: child.answerSubmissionId }
    expect(await processor.process(message)).toMatchObject({ status: 'SUCCEEDED' })
    await processor.process(message)
    expect(verify).toHaveBeenCalledTimes(1)
    expect(await f.task()).toMatchObject({ state: 'PASSED', version: 11 })
    expect(await accepted()).toEqual(child)
    const initial = followUpAnswerResponseSchema.parse(await (await get()).json())
    expect(initial.run).toMatchObject({
      runId: original.runId,
      status: 'FAILED',
      retryRunId: child.runId,
    })
    expect(initial.report).toBeNull()
    const retried = followUpAnswerResponseSchema.parse(await (await get(child.runId)).json())
    expect(retried).toMatchObject({
      answer: initial.answer,
      answerSubmissionId: initial.answerSubmissionId,
      run: { retryOfRunId: original.runId, status: 'SUCCEEDED' },
      report: { body: { result: { outcome: 'PASSED' } } },
    })
    expect(
      await database.agentRun.count({ where: { answerSubmissionId: original.answerSubmissionId } }),
    ).toBe(2)
  })

  it('continues B to C without branching again from A', async () => {
    const b = await accepted()
    await database.agentRun.update({
      where: { id: b.runId },
      data: { status: 'TIMED_OUT', version: 1, finishedAt: new Date() },
    })
    await database.task.update({
      where: { id: f.taskId },
      data: { state: 'NEEDS_EVIDENCE', version: 11 },
    })
    const c = await accepted({ expectedRunVersion: 1, expectedTaskVersion: 11 }, b.runId)
    expect(c.retryOfRunId).toBe(b.runId)
    expect(await accepted()).toEqual(b)
    expect(await (await get(b.runId)).json()).toMatchObject({
      run: { retryOfRunId: original.runId, retryRunId: c.runId },
    })
  })

  it('rolls back Task and new Run if saving Outbox fails', async () => {
    rejectOutbox = true
    const response = await post()
    expect(response.status).toBe(500)
    expect(JSON.stringify(await response.json())).not.toContain('fixture-private')
    expect(await f.task()).toMatchObject({ state: 'NEEDS_EVIDENCE', version: 9 })
    expect(await database.agentRun.count({ where: { retryOfRunId: original.runId } })).toBe(0)
    rejectOutbox = false
    await accepted()
  })

  it.each(['SUCCEEDED', 'RUNNING', 'QUEUED', 'CANCEL_REQUESTED'] as const)(
    'rejects source status %s',
    async (status) => {
      await database.agentRun.update({ where: { id: original.runId }, data: { status } })
      expect((await post()).status).toBe(409)
      expect(await database.agentRun.count({ where: { retryOfRunId: original.runId } })).toBe(0)
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
    'new-note',
    'new-note-run',
    'new-answer',
    'question-source',
    'busy',
  ])('rejects superseded or invalid context: %s', async (change) => {
    if (change === 'new-task')
      await database.task.update({ where: { id: f.taskId }, data: { version: 10 } })
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
    if (change === 'new-note') {
      const note = await database.submission.findUniqueOrThrow({ where: { id: f.submissionId } })
      await database.submission.create({
        data: { ...note, id: randomUUID(), taskVersion: 9, afterCommitSha: 'c'.repeat(40) },
      })
    }
    if (change === 'new-note-run' || change === 'busy')
      await database.agentRun.create({
        data: {
          taskId: f.taskId,
          kind: 'NOTE_VERIFICATION',
          status: change === 'busy' ? 'RUNNING' : 'FAILED',
          expectedTaskVersion: 10,
          taskStateBeforeRun: 'NEEDS_EVIDENCE',
          workflowVersion: 'note-v1',
        },
      })
    if (change === 'question-source')
      await database.followUpQuestion.update({
        where: { id: questionId },
        data: { body: { invalid: 'fixture' } },
      })
    if (change === 'new-answer') {
      const newer = await new FollowUpAnswerService(database).submit(f.userId, questionId, {
        requestId: randomUUID(),
        expectedTaskVersion: 9,
        answer: '新回答。',
      })
      await database.agentRun.update({
        where: { id: newer.runId },
        data: { status: 'FAILED', version: 1, finishedAt: new Date() },
      })
      await database.task.update({
        where: { id: f.taskId },
        data: { state: 'NEEDS_EVIDENCE', version: 11 },
      })
    }
    expect(
      (
        await post({
          expectedRunVersion: change === 'run-version' ? 0 : 1,
          expectedTaskVersion: change === 'task-version' ? 8 : (await f.task()).version,
        })
      ).status,
    ).toBe(409)
    expect(await database.agentRun.count({ where: { retryOfRunId: original.runId } })).toBe(0)
  })

  it('authenticates both commands and selected reads, enforces answer ownership and strict input', async () => {
    expect((await post(undefined, undefined, undefined, { ...headers(), cookie: '' })).status).toBe(
      401,
    )
    expect(
      (
        await post(undefined, undefined, undefined, {
          ...headers(),
          origin: 'https://other.example',
        })
      ).status,
    ).toBe(403)
    expect((await post(undefined, f.runId)).status).toBe(404)
    expect((await post(undefined, original.runId, randomUUID())).status).toBe(404)
    expect((await get(f.runId)).status).toBe(404)
    expect((await get('invalid')).status).toBe(400)
    expect(
      (await post({ expectedRunVersion: 1, expectedTaskVersion: 9, answer: '替换原答案' })).status,
    ).toBe(400)
    const other = await createNoteVerificationFixture(database, (value) => fixtures.push(value))
    await database.user.update({ where: { id: other.userId }, data: { githubLogin: 'other' } })
    token = opaqueToken()
    await database.session.create({
      data: {
        tokenHash: hashToken(token),
        userId: other.userId,
        expiresAt: new Date(Date.now() + 300_000),
      },
    })
    expect((await post()).status).toBe(404)
    expect((await get()).status).toBe(404)
    expect((await get(original.runId)).status).toBe(404)
  })
})
