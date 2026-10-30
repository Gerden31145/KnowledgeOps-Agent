import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import { createDatabaseClient, type DatabaseClient } from '@knowledgeops/database'
import { cancelVerificationRunResponseSchema } from '@knowledgeops/contracts'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppModule } from '../src/app.module.js'
import { API_ENVIRONMENT } from '../src/config/config.module.js'
import { readApiEnvironment } from '../src/config/environment.js'
import { DatabaseService } from '../src/database/database.service.js'
import { hashToken, opaqueToken } from '../src/identity/auth-http.js'
import { FollowUpAnswerService } from '../src/verification/follow-up-answer.service.js'
import { readWorkerEnvironment } from '../../worker/src/config/environment.js'
import {
  createNoteVerificationFixture,
  type NoteFixtureIdentity,
} from '../../worker/test/fixtures/verification.js'
import { NoteVerificationRunRepository } from '../../worker/src/verification/note-verification-run.repository.js'
import { AnswerVerificationRunRepository } from '../../worker/src/verification/answer-verification-run.repository.js'
import { NoteVerificationExecutionRepository } from '../../worker/src/verification/note-verification-execution.repository.js'
import { NoteVerificationJobProcessor } from '../../worker/src/verification/note-verification-job-processor.js'
import { executePersistedNoteVerification } from '../../worker/src/verification/execute-persisted-note-verification.js'

type NoteVerificationPort = Parameters<typeof executePersistedNoteVerification>[1]
type FollowUpGenerationPort = NonNullable<Parameters<typeof executePersistedNoteVerification>[5]>

if (
  !process.env.DATABASE_URL ||
  !['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname)
)
  throw new Error('R15 integration requires a local DATABASE_URL')
const apiEnvironment = readApiEnvironment({
  DATABASE_URL: process.env.DATABASE_URL,
  NODE_ENV: 'test',
  WEB_ORIGIN: 'http://127.0.0.1:3000',
})
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
let rejectCancel = false
// 只创建随机夹具；待办停放到未来，恢复扫描也只处理本文件的 Task。
const fixtures: NoteFixtureIdentity[] = []
const database = createDatabaseClient(apiEnvironment.DATABASE_URL).$extends({
  query: {
    outboxEvent: {
      create({ args, query }) {
        return query({ ...args, data: { ...args.data, availableAt: new Date('2099-01-01') } })
      },
    },
    agentRun: {
      update({ args, query }) {
        if (rejectCancel && args.data.status === 'CANCEL_REQUESTED')
          throw new Error('fixture-private-cancel-error')
        return query(args)
      },
    },
  },
}) as unknown as DatabaseClient
const scoped = database.$extends({
  query: {
    agentRun: {
      findMany({ args, query }) {
        return query({
          ...args,
          where: { AND: [args.where ?? {}, { taskId: { in: fixtures.map((f) => f.taskId) } }] },
        })
      },
    },
  },
}) as unknown as DatabaseClient
const runs = new NoteVerificationRunRepository(scoped, workerEnvironment)
const answerRuns = new AnswerVerificationRunRepository(scoped, workerEnvironment)
const ledger = new NoteVerificationExecutionRepository(database)
const usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 }
const verify = vi.fn<NoteVerificationPort['verify']>()
const generate: FollowUpGenerationPort['generate'] = async (request) => ({
  usage,
  candidate: {
    question: '微任务又加入微任务时，为什么仍先于下一宏任务？',
    rubric: ['说明微任务队列会清空。'],
    citations: [{ startLine: 3, endLine: 3, excerpt: request.note.lines[2]! }],
  },
})
const normalVerify: NoteVerificationPort['verify'] = async (request) => ({
  usage,
  candidate: {
    results: request.criteria.map((criterion) => ({
      criterionId: criterion.id,
      outcome: 'PASSED',
      rationale: '合成笔记判断',
      suggestions: [],
      confidence: 0.8,
      citations: [{ startLine: 3, endLine: 3, excerpt: request.note.lines[2]! }],
    })),
  },
})
const processor = new NoteVerificationJobProcessor(runs, ledger, { verify }, { generate })
async function fixture() {
  const f = await createNoteVerificationFixture(database, (value) => fixtures.push(value))
  await database.user.update({ where: { id: f.userId }, data: { githubLogin: 'r15-fixture' } })
  const token = opaqueToken()
  await database.session.create({
    data: {
      tokenHash: hashToken(token),
      userId: f.userId,
      expiresAt: new Date(Date.now() + 300_000),
    },
  })
  return { ...f, token }
}
let f: Awaited<ReturnType<typeof fixture>>
let app: INestApplication
let baseUrl: string
const headers = (token = f.token) => ({
  cookie: `knowledgeops_session=${token}`,
  origin: apiEnvironment.WEB_ORIGIN,
  'content-type': 'application/json',
})
const post = (version = 0, runId = f.runId, requestHeaders = headers()) =>
  fetch(`${baseUrl}/agent-runs/${runId}/cancel`, {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify({ expectedRunVersion: version }),
  })
async function accepted(version = 0, runId = f.runId) {
  const response = await post(version, runId)
  expect(response.status).toBe(202)
  return cancelVerificationRunResponseSchema.parse(await response.json())
}
beforeAll(async () => {
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(API_ENVIRONMENT)
    .useValue(apiEnvironment)
    .overrideProvider(DatabaseService)
    .useValue({ client: database })
    .compile()
  app = module.createNestApplication({ logger: false })
  await app.listen(0, '127.0.0.1')
  baseUrl = await app.getUrl()
})
beforeEach(async () => {
  rejectCancel = false
  verify.mockReset().mockImplementation(normalVerify)
  f = await fixture()
})
afterEach(async () => {
  rejectCancel = false
  for (const fixture of fixtures.splice(0).reverse()) {
    const ids = (
      await database.agentRun.findMany({ where: { taskId: fixture.taskId }, select: { id: true } })
    ).map((r) => r.id)
    await database.outboxEvent.deleteMany({ where: { aggregateId: { in: ids } } })
    await database.agentRun.deleteMany({
      where: { taskId: fixture.taskId, kind: 'ANSWER_VERIFICATION' },
    })
    await database.answerSubmission.deleteMany({
      where: { question: { report: { run: { taskId: fixture.taskId } } } },
    })
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

describe('R15 authenticated verification cancellation', () => {
  it('persists one intent under concurrent repeat POSTs, then skips the queued model call and restores Task', async () => {
    const responses = await Promise.all([accepted(), accepted(), accepted()])
    expect(responses.every((r) => r.status === 'CANCEL_REQUESTED' && r.version === 1)).toBe(true)
    expect(await f.task()).toMatchObject({ state: 'VERIFYING', version: 6 })
    expect(await processor.process(f.payload)).toMatchObject({
      status: 'CANCELLED',
      reportId: null,
    })
    expect(verify).not.toHaveBeenCalled()
    expect(await f.task()).toMatchObject({ state: 'IN_PROGRESS', version: 7 })
    expect(await accepted()).toMatchObject({ status: 'CANCELLED', version: 2 })
    expect(await database.outboxEvent.count({ where: { id: f.eventId } })).toBe(1)
    const current = await fetch(`${baseUrl}/agent-runs/${f.runId}`, { headers: headers() })
    expect(await current.json()).toMatchObject({ status: 'CANCELLED', report: null })
  })

  it('lets recovery cancel during an in-flight model call and refuses the late report', async () => {
    let entered!: () => void, release!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    verify.mockImplementationOnce(async (request, options) => {
      entered()
      await gate
      return normalVerify(request, options)
    })
    const processing = processor.process(f.payload)
    try {
      await started
      expect(await accepted(1)).toMatchObject({ status: 'CANCEL_REQUESTED', version: 2 })
      await runs.reconcile(20)
      expect(await f.run()).toMatchObject({ status: 'CANCELLED', report: null })
      expect(await f.task()).toMatchObject({ state: 'IN_PROGRESS', version: 7 })
    } finally {
      release()
      await processing
    }
    expect(await processing).toMatchObject({ status: 'CANCELLED' })
    expect((await f.run()).report).toBeNull()
    expect(verify).toHaveBeenCalledOnce()
  })

  it('preserves a completed report when success wins before the cancellation request', async () => {
    await processor.process(f.payload)
    const before = await f.run(),
      task = await f.task()
    expect(before.status).toBe('SUCCEEDED')
    expect(await accepted(0)).toMatchObject({ status: 'SUCCEEDED', version: before.version })
    expect(await f.run()).toEqual(before)
    expect(await f.task()).toEqual(task)
  })

  it('serializes cancellation against atomic finalization without a cancelled Run owning a report', async () => {
    const prepared = await runs.prepare(f.payload)
    if (!prepared.ready) throw new Error('fixture not ready')
    await executePersistedNoteVerification(
      ledger,
      { verify },
      prepared.input,
      {
        signal: new AbortController().signal,
        maxOutputTokens: prepared.configuration.maxOutputTokens,
      },
      prepared.configuration.budget,
      { generate },
    )
    const request = post(1)
    const finishing = runs.finalize(f.payload)
    const [response] = await Promise.all([request, finishing])
    expect(response.status).toBe(202)
    await runs.reconcile(20)
    const run = await f.run(),
      task = await f.task()
    expect(['SUCCEEDED', 'CANCELLED']).toContain(run.status)
    expect(Boolean(run.report)).toBe(run.status === 'SUCCEEDED')
    expect(task.state).toBe(run.status === 'SUCCEEDED' ? 'NEEDS_EVIDENCE' : 'IN_PROGRESS')
    expect(task.version).toBe(7)
  })

  it('does not restore a newer Task version while cancelling an old Run', async () => {
    await database.task.update({ where: { id: f.taskId }, data: { version: 7 } })
    await accepted()
    await runs.reconcile(20)
    expect(await f.run()).toMatchObject({ status: 'CANCELLED' })
    expect(await f.task()).toMatchObject({ state: 'VERIFYING', version: 7 })
  })

  it('rejects stale active Run versions and invalid command bodies', async () => {
    expect((await post(99)).status).toBe(409)
    for (const body of [
      {},
      { expectedRunVersion: -1 },
      { expectedRunVersion: 0, userId: f.userId },
    ]) {
      expect(
        (
          await fetch(`${baseUrl}/agent-runs/${f.runId}/cancel`, {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify(body),
          })
        ).status,
      ).toBe(400)
    }
    expect(await f.run()).toMatchObject({ status: 'QUEUED', version: 0 })
  })

  it('requires session and Origin and hides other owners behind the same 404', async () => {
    expect((await post(0, f.runId, { ...headers(), cookie: '' })).status).toBe(401)
    expect((await post(0, f.runId, { ...headers(), origin: 'https://other.example' })).status).toBe(
      403,
    )
    const other = await fixture()
    expect((await post(0, f.runId, headers(other.token))).status).toBe(404)
    expect((await post(0, randomUUID())).status).toBe(404)
    expect(await f.run()).toMatchObject({ status: 'QUEUED', version: 0 })
  })

  it('rolls back a failed cancellation write and returns a safe HTTP error', async () => {
    rejectCancel = true
    const response = await post()
    expect(response.status).toBe(500)
    expect(JSON.stringify(await response.json())).not.toContain('fixture-private-cancel-error')
    expect(await f.run()).toMatchObject({ status: 'QUEUED', version: 0 })
    expect(await f.task()).toMatchObject({ state: 'VERIFYING', version: 6 })
    rejectCancel = false
    expect(await accepted()).toMatchObject({ status: 'CANCEL_REQUESTED' })
  })

  it('cancels an answer Run through the same API and restores NEEDS_EVIDENCE without deleting the answer', async () => {
    const note = await processor.process(f.payload)
    const question = await database.followUpQuestion.findUniqueOrThrow({
      where: { reportId: note.reportId! },
    })
    const answer = await new FollowUpAnswerService(database).submit(f.userId, question.id, {
      requestId: randomUUID(),
      expectedTaskVersion: (await f.task()).version,
      answer: '微任务队列先清空。',
    })
    expect(await accepted(0, answer.runId)).toMatchObject({ status: 'CANCEL_REQUESTED' })
    await answerRuns.reconcile(20)
    const current = await new FollowUpAnswerService(database).get(
      f.userId,
      answer.answerSubmissionId,
    )
    expect(current).toMatchObject({
      answer: '微任务队列先清空。',
      run: { status: 'CANCELLED' },
      report: null,
    })
    expect(await f.task()).toMatchObject({
      state: 'NEEDS_EVIDENCE',
      version: answer.taskVersion + 1,
    })
  })
})
