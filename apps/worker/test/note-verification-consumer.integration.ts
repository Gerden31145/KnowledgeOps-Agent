import { randomUUID } from 'node:crypto'
import { createDatabaseClient, Prisma, type DatabaseClient } from '@knowledgeops/database'
import {
  buildNoteVerificationJobId,
  noteVerificationReportBodySchema,
} from '@knowledgeops/contracts'
import type {
  NoteVerificationPort,
  NoteVerificationRequest,
  FollowUpGenerationPort,
  FollowUpGenerationRequest,
} from '@knowledgeops/agent-core'
import { Queue, QueueEvents } from 'bullmq'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { readWorkerEnvironment } from '../src/config/environment.js'
import { NoteVerificationRunRepository } from '../src/verification/note-verification-run.repository.js'
import { NoteVerificationExecutionRepository } from '../src/verification/note-verification-execution.repository.js'
import { NoteVerificationJobProcessor } from '../src/verification/note-verification-job-processor.js'
import { executePersistedNoteVerification } from '../src/verification/execute-persisted-note-verification.js'
import { BullMqNoteVerificationQueue } from '../src/queue/bullmq-note-verification-queue.js'
import { bullMqWorkerConnection } from '../src/queue/bullmq-connections.js'
import { OutboxDispatcher } from '../src/outbox/outbox-dispatcher.js'
import { NoteVerificationQueryService } from '../../api/src/verification/note-verification-query.service.js'
import { createNoteVerificationFixture } from './fixtures/verification.js'

// 真实 PostgreSQL / Redis；模型只用合成返回，不读取用户笔记，不调用供应商。
const environment = readWorkerEnvironment({
  ...process.env,
  OPENAI_API_KEY: 'fixture-not-a-real-key',
  NOTE_VERIFICATION_TIMEOUT_MS: '30000',
  NOTE_VERIFICATION_MODEL_JSON: JSON.stringify({
    catalogId: 'glm-5-3',
    modelName: 'glm-5.3',
    currency: 'CNY',
    inputMicrounitsPerMillionTokens: 8_000_000,
    outputMicrounitsPerMillionTokens: 28_000_000,
  }),
})
const database = createDatabaseClient(environment.DATABASE_URL)
const fixtures: {
  userId: string
  taskId: string
  runId: string
  eventId: string
  installationId: string
}[] = []
const resources: (() => Promise<void>)[] = []
const usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 }
const response = (request: NoteVerificationRequest) => ({
  usage,
  candidate: {
    results: request.criteria.map((criterion) => ({
      criterionId: criterion.id,
      outcome: 'PASSED' as const,
      confidence: 0.8,
      rationale: '合成模型：正文包含解释。',
      suggestions: [],
      citations: [{ startLine: 3, endLine: 3, excerpt: request.note.lines[2]! }],
    })),
  },
})
const questionResponse = (request: FollowUpGenerationRequest) => ({
  usage,
  candidate: {
    question: '如果清空微任务时又加入一个微任务，会先执行它还是下一个宏任务？为什么？',
    rubric: ['说明微任务队列会继续清空后才进入下一个宏任务。'],
    citations: [{ startLine: 3, endLine: 3, excerpt: request.note.lines[2]! }],
  },
})

const fixture = () => createNoteVerificationFixture(database, (value) => fixtures.push(value))
function processor(
  verify: NoteVerificationPort['verify'],
  db: DatabaseClient = database,
  now = () => new Date(),
  generate?: FollowUpGenerationPort['generate'],
) {
  // 恢复扫描也限定本文件随机夹具，不能收尾本机用户正在运行的任务。
  const scoped = db.$extends({
    query: {
      agentRun: {
        async findMany({ args, query }) {
          return query({
            ...args,
            where: { AND: [args.where ?? {}, { id: { in: fixtures.map((f) => f.runId) } }] },
          })
        },
      },
    },
  }) as unknown as DatabaseClient
  const runs = new NoteVerificationRunRepository(scoped, environment, now)
  const ledger = new NoteVerificationExecutionRepository(db)
  return {
    runs,
    ledger,
    handler: new NoteVerificationJobProcessor(
      runs,
      ledger,
      { verify },
      generate ? { generate } : undefined,
    ),
  }
}
async function transport(handler: Pick<NoteVerificationJobProcessor, 'process'>) {
  const queueName = `r09-fixture-${randomUUID()}`
  const queue = new BullMqNoteVerificationQueue({
    processor: handler,
    redisUrl: environment.REDIS_URL,
    concurrency: 2,
    queueName,
    jobOptions: { attempts: 2, backoffDelayMs: 100 },
  })
  const inspector = new Queue(queueName, {
    connection: bullMqWorkerConnection(environment.REDIS_URL),
  })
  const events = new QueueEvents(queueName, {
    connection: bullMqWorkerConnection(environment.REDIS_URL),
  })
  resources.push(async () => {
    await queue.close()
    await events.close()
    await inspector.obliterate({ force: true })
    await inspector.close()
  })
  await Promise.all([queue.waitUntilReady(), inspector.waitUntilReady(), events.waitUntilReady()])
  return { queue, inspector, events }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of resources.splice(0).reverse()) await close()
  for (const f of fixtures.splice(0).reverse()) {
    await database.outboxEvent.deleteMany({ where: { id: f.eventId } })
    await database.agentRun.deleteMany({ where: { taskId: f.taskId } })
    await database.submission.deleteMany({ where: { taskId: f.taskId } })
    await database.user.deleteMany({ where: { id: f.userId } })
    await database.gitHubInstallation.deleteMany({ where: { id: f.installationId } })
  }
})
afterAll(() => database.$disconnect())

describe('R10 shared note/question execution and atomic persistence', () => {
  it('leaves answer verification intents pending until an answer publisher is installed', async () => {
    const f = await fixture()
    await database.outboxEvent.update({
      where: { id: f.eventId },
      data: {
        type: 'ANSWER_VERIFICATION_REQUESTED',
        payload: { runId: f.runId, answerSubmissionId: randomUUID() },
      },
    })
    const publisher = {
      publish: vi.fn(),
      publishNoteVerification: vi.fn(),
      publishGitHubPush: vi.fn(),
      publishGitHubEvidenceRetry: vi.fn(),
    }
    const dispatcher = new OutboxDispatcher(database, publisher, {
      baseDelayMs: 100,
      maxDelayMs: 1000,
    })
    expect(await dispatcher.dispatchEvent(f.eventId)).toEqual({ status: 'EMPTY' })
    for (const publish of Object.values(publisher)) expect(publish).not.toHaveBeenCalled()
    expect(await database.outboxEvent.findUnique({ where: { id: f.eventId } })).toMatchObject({
      dispatchedAt: null,
      deadLetteredAt: null,
    })
  })
  it('dispatches both steps through one Run and returns one private-owner question without its rubric', async () => {
    const f = await fixture()
    const verify = vi
      .fn<NoteVerificationPort['verify']>()
      .mockImplementation(async (r) => response(r))
    const generate = vi
      .fn<FollowUpGenerationPort['generate']>()
      .mockImplementation(async (r) => questionResponse(r))
    const { handler } = processor(verify, database, undefined, generate)
    const { queue, inspector, events } = await transport(handler)
    const dispatcher = new OutboxDispatcher(
      database,
      { publish: vi.fn(), publishNoteVerification: (message) => queue.publish(message) },
      { baseDelayMs: 100, maxDelayMs: 1000 },
    )
    await dispatcher.dispatchEvent(f.eventId)
    const job = await inspector.getJob(buildNoteVerificationJobId(f.runId))
    queue.start()
    const result = await job!.waitUntilFinished(events, 10_000)
    expect(result.status).toBe('SUCCEEDED')
    const run = await f.run()
    expect(run.modelExecution).toMatchObject({ attemptCount: 2, pendingAttempt: null })
    const saved = await database.followUpQuestion.findUniqueOrThrow({
      where: { reportId: result.reportId },
    })
    expect(saved.body).toMatchObject({
      source: {
        taskId: f.taskId,
        submissionId: f.submissionId,
        noteRunId: f.runId,
        reportId: result.reportId,
        repositoryId: f.repositoryId,
        commitSha: 'b'.repeat(40),
      },
      rubric: expect.any(Array),
    })
    const queries = new NoteVerificationQueryService(database)
    const queried = await queries.getRun(f.runId, f.userId)
    expect(queried.followUpQuestion).toMatchObject({
      id: saved.id,
      question: expect.any(String),
      citations: expect.any(Array),
    })
    expect(JSON.stringify(queried)).not.toContain('rubric')
    expect(queried.report?.body).toMatchObject({
      followUp: { status: 'READY' },
      accounting: { knownTotalTokens: 300, knownCostMicrounits: 4400 },
    })
    await expect(queries.getRun(f.runId, randomUUID())).rejects.toMatchObject({ status: 404 })
    await expect(handler.process(f.payload)).resolves.toEqual(result)
    expect(verify).toHaveBeenCalledOnce()
    expect(generate).toHaveBeenCalledOnce()
    expect(await database.followUpQuestion.count({ where: { reportId: result.reportId } })).toBe(1)
    expect(await f.task()).toMatchObject({ state: 'VERIFYING', version: 6 })
  })

  it('rolls back report and terminal state if the question write fails, then reuses both saved model results', async () => {
    const f = await fixture()
    const faulty = database.$extends({
      query: {
        followUpQuestion: {
          async create() {
            throw new Error('fixture-question-write-outage')
          },
        },
      },
    }) as unknown as DatabaseClient
    const verify = vi
      .fn<NoteVerificationPort['verify']>()
      .mockImplementation(async (r) => response(r))
    const generate = vi
      .fn<FollowUpGenerationPort['generate']>()
      .mockImplementation(async (r) => questionResponse(r))
    await expect(
      processor(verify, faulty, undefined, generate).handler.process(f.payload),
    ).rejects.toThrow('fixture-question-write-outage')
    expect(await f.run()).toMatchObject({
      status: 'RUNNING',
      report: null,
      modelExecution: {
        attemptCount: 2,
        result: { status: 'SUCCEEDED', followUp: { status: 'READY' } },
      },
    })
    const normal = processor(verify, database, undefined, generate)
    const result = await normal.handler.process(f.payload)
    expect(result.status).toBe('SUCCEEDED')
    expect(await database.followUpQuestion.count({ where: { reportId: result.reportId! } })).toBe(1)
    expect(verify).toHaveBeenCalledOnce()
    expect(generate).toHaveBeenCalledOnce()
  })

  it.each(['unbind', 'version', 'cancel'] as const)(
    'rejects the question after %s during generation',
    async (change) => {
      const f = await fixture()
      const { handler } = processor(
        async (r) => response(r),
        database,
        undefined,
        async (request) => {
          if (change === 'unbind')
            await database.repository.update({
              where: { id: f.repositoryId },
              data: { enabled: false },
            })
          if (change === 'version')
            await database.task.update({ where: { id: f.taskId }, data: { version: 7 } })
          if (change === 'cancel')
            await database.agentRun.update({
              where: { id: f.runId },
              data: { status: 'CANCEL_REQUESTED', version: { increment: 1 } },
            })
          return questionResponse(request)
        },
      )
      expect(await handler.process(f.payload)).toMatchObject({
        status: change === 'cancel' ? 'CANCELLED' : 'FAILED',
        reportId: null,
      })
      expect((await f.run()).report).toBeNull()
      expect(await database.followUpQuestion.count({ where: { report: { runId: f.runId } } })).toBe(
        0,
      )
    },
  )

  it.each(['failed-section', 'snapshot-exemption'] as const)(
    'derives question eligibility from R08 checks: %s',
    async (kind) => {
      const f = await fixture()
      if (kind === 'failed-section')
        await database.acceptanceCriterion.updateMany({
          where: { taskId: f.taskId, type: 'SECTION_PRESENT' },
          data: { config: { heading: '不存在的章节' } },
        })
      else
        await database.evidence.update({
          where: { submissionId: f.submissionId },
          data: { mode: 'SNAPSHOT', change: null, diff: null },
        })
      const generate = vi
        .fn<FollowUpGenerationPort['generate']>()
        .mockImplementation(async (r) => questionResponse(r))
      await processor(async (r) => response(r), database, undefined, generate).handler.process(
        f.payload,
      )
      const queried = await new NoteVerificationQueryService(database).getRun(f.runId, f.userId)
      if (kind === 'failed-section') {
        expect(generate).not.toHaveBeenCalled()
        expect(queried.followUpQuestion).toBeNull()
        expect(queried.report?.body.followUp).toEqual({
          status: 'SKIPPED',
          reason: 'NOTE_CRITERIA_NOT_PASSED',
        })
      } else {
        expect(generate).toHaveBeenCalledOnce()
        expect(queried.followUpQuestion).not.toBeNull()
        expect(queried.report?.body.exemptions).toHaveLength(1)
      }
    },
  )

  it('keeps the note report when semantic repair uses both calls and never restores a fresh question budget', async () => {
    const f = await fixture()
    const verify = vi
      .fn<NoteVerificationPort['verify']>()
      .mockResolvedValueOnce({ candidate: { results: [] }, usage })
      .mockImplementation(async (r) => response(r))
    const generate = vi.fn<FollowUpGenerationPort['generate']>()
    const { handler } = processor(verify, database, undefined, generate)
    const result = await handler.process(f.payload)
    expect(result.status).toBe('SUCCEEDED')
    expect(noteVerificationReportBodySchema.parse((await f.run()).report!.body).followUp).toEqual({
      status: 'FAILED',
      code: 'MODEL_CALL_LIMIT_EXCEEDED',
    })
    await handler.process(f.payload)
    expect(verify).toHaveBeenCalledTimes(2)
    expect(generate).not.toHaveBeenCalled()
  })

  it('preserves an already frozen R09 configuration without adding a new model step', async () => {
    const f = await fixture()
    const verify = vi
      .fn<NoteVerificationPort['verify']>()
      .mockImplementation(async (r) => response(r))
    const generate = vi.fn<FollowUpGenerationPort['generate']>()
    const { runs, handler } = processor(verify, database, undefined, generate)
    const prepared = await runs.prepare(f.payload)
    if (!prepared.ready) throw new Error('fixture-not-ready')
    const legacy = { ...prepared.configuration }
    delete legacy.followUp
    await database.agentRun.update({
      where: { id: f.runId },
      data: {
        executionConfiguration: JSON.parse(JSON.stringify(legacy)) as Prisma.InputJsonValue,
      },
    })
    expect(await handler.process(f.payload)).toMatchObject({ status: 'SUCCEEDED' })
    const queried = await new NoteVerificationQueryService(database).getRun(f.runId, f.userId)
    expect(queried.report?.body.followUp).toBeNull()
    expect(queried.followUpQuestion).toBeNull()
    expect(verify).toHaveBeenCalledOnce()
    expect(generate).not.toHaveBeenCalled()
  })
})

describe('R09 real note consumer and atomic report', () => {
  it('dispatches through BullMQ, merges checks, queries only as owner and replays without another model call', async () => {
    const f = await fixture()
    const verify = vi
      .fn<NoteVerificationPort['verify']>()
      .mockImplementation(async (request) => response(request))
    const { handler } = processor(verify)
    const { queue, inspector, events } = await transport(handler)
    const dispatcher = new OutboxDispatcher(
      database,
      { publish: vi.fn(), publishNoteVerification: (message) => queue.publish(message) },
      { baseDelayMs: 100, maxDelayMs: 1000 },
    )
    await expect(dispatcher.dispatchEvent(f.eventId)).resolves.toMatchObject({
      status: 'DISPATCHED',
    })
    const job = await inspector.getJob(buildNoteVerificationJobId(f.runId))
    expect(job?.data).toEqual(f.payload)
    queue.start()
    const result = await job!.waitUntilFinished(events, 10_000)
    expect(result).toMatchObject({ status: 'SUCCEEDED', reportId: expect.any(String) })
    const queries = new NoteVerificationQueryService(database)
    const queried = await queries.getRun(f.runId, f.userId)
    expect(queried.status).toBe('SUCCEEDED')
    expect(queried.report?.body.results).toHaveLength(3)
    expect(queried.report?.body.pendingCriterionIds).toHaveLength(1)
    expect(queried.report?.body.accounting).toMatchObject({
      knownTotalTokens: 150,
      knownCostMicrounits: 2200,
      currency: 'CNY',
    })
    expect(queried.report?.body.results[2]?.citations[0]).toMatchObject({
      repositoryId: f.repositoryId,
      commitSha: 'b'.repeat(40),
    })
    await expect(queries.getRun(f.runId, randomUUID())).rejects.toMatchObject({ status: 404 })
    expect(JSON.stringify(queried)).not.toContain('fixture-not-a-real-key')
    await expect(handler.process(f.payload)).resolves.toEqual(result)
    expect(verify).toHaveBeenCalledOnce()
    expect(await database.verificationReport.count({ where: { runId: f.runId } })).toBe(1)
    expect(await f.task()).toMatchObject({ state: 'VERIFYING', version: 6 })
  })

  it('rolls back report + terminal status together and recovers the saved result without paying again', async () => {
    const f = await fixture()
    let fail = true
    const faulty = database.$extends({
      query: {
        agentRun: {
          async update({ args, query }) {
            if (args.data.status === 'SUCCEEDED' && fail) {
              fail = false
              throw new Error('fixture-final-write-outage')
            }
            return query(args)
          },
        },
      },
    }) as unknown as DatabaseClient
    const verify = vi
      .fn<NoteVerificationPort['verify']>()
      .mockImplementation(async (request) => response(request))
    await expect(processor(verify, faulty).handler.process(f.payload)).rejects.toThrow(
      'fixture-final-write-outage',
    )
    expect(await f.run()).toMatchObject({
      status: 'RUNNING',
      report: null,
      modelExecution: { result: { status: 'SUCCEEDED' } },
    })
    await processor(verify).runs.reconcile(100)
    expect(await f.run()).toMatchObject({ status: 'SUCCEEDED', report: { id: expect.any(String) } })
    await processor(verify).handler.process(f.payload)
    expect(verify).toHaveBeenCalledOnce()
  })

  it('does not complete a busy duplicate or reset its budget', async () => {
    const f = await fixture()
    let release!: () => void, entered!: () => void
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const verify = vi.fn<NoteVerificationPort['verify']>().mockImplementation(async (request) => {
      entered()
      await waiting
      return response(request)
    })
    const { handler } = processor(verify)
    const first = handler.process(f.payload)
    try {
      await started
      await expect(handler.process(f.payload)).rejects.toThrow('NOTE_EXECUTION_IN_PROGRESS')
      expect(await f.run()).toMatchObject({
        status: 'RUNNING',
        modelExecution: { attemptCount: 1, pendingAttempt: 1 },
      })
    } finally {
      release()
    }
    expect(await first).toMatchObject({ status: 'SUCCEEDED' })
    expect(verify).toHaveBeenCalledOnce()
  })

  it.each(['unbind', 'version', 'cancel'] as const)(
    'refuses a result after %s during the model call',
    async (change) => {
      const f = await fixture()
      const { handler } = processor(async (request) => {
        if (change === 'unbind')
          await database.repository.update({
            where: { id: f.repositoryId },
            data: { enabled: false },
          })
        if (change === 'version')
          await database.task.update({ where: { id: f.taskId }, data: { version: 7 } })
        if (change === 'cancel')
          await database.agentRun.update({
            where: { id: f.runId },
            data: { status: 'CANCEL_REQUESTED', version: { increment: 1 } },
          })
        return response(request)
      })
      expect(await handler.process(f.payload)).toMatchObject({
        status: change === 'cancel' ? 'CANCELLED' : 'FAILED',
        reportId: null,
      })
      expect((await f.run()).report).toBeNull()
      expect(await f.task()).toMatchObject(
        change === 'version'
          ? { state: 'VERIFYING', version: 7 }
          : { state: 'IN_PROGRESS', version: 7 },
      )
    },
  )

  it('checks stale eligibility before calling the model and rejects a foreign submission', async () => {
    const f = await fixture()
    const verify = vi.fn<NoteVerificationPort['verify']>()
    const { handler } = processor(verify)
    expect(await handler.process({ ...f.payload, submissionId: randomUUID() })).toMatchObject({
      status: 'IGNORED',
    })
    expect((await f.run()).status).toBe('QUEUED')
    await database.task.update({ where: { id: f.taskId }, data: { version: 7 } })
    expect(await handler.process(f.payload)).toMatchObject({ status: 'FAILED' })
    expect(verify).not.toHaveBeenCalled()
    expect(await f.task()).toMatchObject({ state: 'VERIFYING', version: 7 })
  })

  it('times out a crashed reservation without another call, and refuses late completion', async () => {
    const f = await fixture()
    const verify = vi.fn<NoteVerificationPort['verify']>()
    const normal = processor(verify)
    const prepared = await normal.runs.prepare(f.payload)
    if (!prepared.ready) throw new Error('fixture-not-ready')
    // 模拟 reserve 已提交、进程在 provider 请求/结算之间退出；不得把 pending 记为零费用。
    vi.spyOn(normal.ledger, 'settle').mockRejectedValueOnce(new Error('fixture-crash-after-call'))
    await expect(
      executePersistedNoteVerification(
        normal.ledger,
        { verify: async (request) => response(request) },
        prepared.input,
        {
          signal: new AbortController().signal,
          maxOutputTokens: prepared.configuration.maxOutputTokens,
        },
        prepared.configuration.budget,
      ),
    ).rejects.toThrow('fixture-crash-after-call')
    const later = processor(
      verify,
      database,
      () => new Date(prepared.configuration.budget.deadlineAt.getTime() + 1),
    )
    await later.runs.reconcile(100)
    expect(await f.run()).toMatchObject({
      status: 'TIMED_OUT',
      errorCode: 'RUN_DEADLINE_EXCEEDED',
      report: null,
      modelExecution: { pendingAttempt: 1, result: null },
    })
    expect(await f.task()).toMatchObject({ state: 'IN_PROGRESS', version: 7 })
    expect(await normal.handler.process(f.payload)).toMatchObject({ status: 'TIMED_OUT' })
    expect(verify).not.toHaveBeenCalled()
  })

  it('closes a queue failure that occurred before PostgreSQL could claim the Run', async () => {
    const f = await fixture()
    const process = vi
      .fn()
      .mockRejectedValue(new Error('fixture-database-unavailable-private-details'))
    const { queue, inspector, events } = await transport({ process })
    await queue.publish({ eventId: f.eventId, payload: f.payload })
    const job = await inspector.getJob(buildNoteVerificationJobId(f.runId))
    queue.start()
    await expect(job!.waitUntilFinished(events, 10_000)).rejects.toThrow(
      'NOTE_VERIFICATION_RETRY_REQUIRED',
    )
    expect(process).toHaveBeenCalledTimes(2)
    expect((await f.run()).status).toBe('QUEUED')
    await processor(vi.fn()).runs.reconcile(100, (message) => queue.isFailed(message))
    expect(await f.run()).toMatchObject({
      status: 'FAILED',
      errorCode: 'NOTE_QUEUE_FAILED',
      report: null,
    })
    expect(await f.task()).toMatchObject({ state: 'IN_PROGRESS', version: 7 })
  })

  it.each(['unknown', 'over-budget'] as const)(
    'preserves valid results with %s accounting warnings',
    async (kind) => {
      const f = await fixture()
      const verify = vi
        .fn<NoteVerificationPort['verify']>()
        .mockImplementation(async (request) => ({
          ...response(request),
          usage:
            kind === 'unknown'
              ? null
              : { inputTokens: 100_000, outputTokens: 50_000, totalTokens: 150_000 },
        }))
      expect(await processor(verify).handler.process(f.payload)).toMatchObject({
        status: 'SUCCEEDED',
      })
      const body = noteVerificationReportBodySchema.parse((await f.run()).report!.body)
      expect(body.accounting.warnings).toContain(
        kind === 'unknown' ? 'MODEL_USAGE_UNKNOWN' : 'MODEL_BUDGET_EXCEEDED',
      )
      expect(verify).toHaveBeenCalledOnce()
    },
  )

  it('records execution success even if the semantic criterion is FAILED, without passing Task', async () => {
    const f = await fixture()
    expect(
      await processor(async (request) => {
        const value = response(request)
        return {
          ...value,
          candidate: {
            results: value.candidate.results.map((item) => ({
              ...item,
              outcome: 'FAILED' as const,
            })),
          },
        }
      }).handler.process(f.payload),
    ).toMatchObject({ status: 'SUCCEEDED' })
    expect(
      noteVerificationReportBodySchema.parse((await f.run()).report!.body).results[2]?.outcome,
    ).toBe('FAILED')
    expect((await f.task()).state).toBe('VERIFYING')
  })

  it('leaves intents pending without a configured consumer and dead-letters inconsistent envelopes', async () => {
    const f = await fixture()
    const basic = new OutboxDispatcher(
      database,
      { publish: vi.fn() },
      { baseDelayMs: 100, maxDelayMs: 1000 },
    )
    expect(await basic.dispatchEvent(f.eventId)).toEqual({ status: 'EMPTY' })
    await database.outboxEvent.update({
      where: { id: f.eventId },
      data: { payload: { ...f.payload, runId: randomUUID() } },
    })
    const publishNoteVerification = vi.fn()
    const enabled = new OutboxDispatcher(
      database,
      { publish: vi.fn(), publishNoteVerification },
      { baseDelayMs: 100, maxDelayMs: 1000 },
    )
    expect(await enabled.dispatchEvent(f.eventId)).toMatchObject({ status: 'DEAD_LETTERED' })
    expect(publishNoteVerification).not.toHaveBeenCalled()
  })
})
