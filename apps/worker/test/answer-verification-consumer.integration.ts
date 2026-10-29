import { randomUUID } from 'node:crypto'
import { createDatabaseClient, type DatabaseClient, type Prisma } from '@knowledgeops/database'
import {
  buildAnswerVerificationJobId,
  answerVerificationReportBodySchema,
} from '@knowledgeops/contracts'
import type { AnswerVerificationPort, AnswerVerificationRequest } from '@knowledgeops/agent-core'
import { Queue, QueueEvents } from 'bullmq'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { FollowUpAnswerService } from '../../api/src/verification/follow-up-answer.service.js'
import { readWorkerEnvironment } from '../src/config/environment.js'
import { NoteVerificationRunRepository } from '../src/verification/note-verification-run.repository.js'
import {
  NoteVerificationExecutionRepository,
  VerificationExecutionRepository,
} from '../src/verification/note-verification-execution.repository.js'
import { NoteVerificationJobProcessor } from '../src/verification/note-verification-job-processor.js'
import { AnswerVerificationRunRepository } from '../src/verification/answer-verification-run.repository.js'
import { AnswerVerificationJobProcessor } from '../src/verification/answer-verification-job-processor.js'
import {
  answerExecutionResultSchema,
  executePersistedAnswerVerification,
} from '../src/verification/execute-persisted-answer-verification.js'
import { BullMqAnswerVerificationQueue } from '../src/queue/bullmq-answer-verification-queue.js'
import { bullMqWorkerConnection } from '../src/queue/bullmq-connections.js'
import { OutboxDispatcher } from '../src/outbox/outbox-dispatcher.js'
import { createNoteVerificationFixture, type NoteFixtureIdentity } from './fixtures/verification.js'

// 真实 PG/Redis；仅随机合成材料及模型响应。待办延后到 2099，避免被其他终端的 Worker 领取。
const environment = readWorkerEnvironment({
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
const fixtures: NoteFixtureIdentity[] = []
const resources: (() => Promise<void>)[] = []
const database = createDatabaseClient(environment.DATABASE_URL).$extends({
  query: {
    outboxEvent: {
      create({ args, query }) {
        return query({ ...args, data: { ...args.data, availableAt: new Date('2099-01-01') } })
      },
    },
  },
}) as unknown as DatabaseClient
const usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 }
function response(request: AnswerVerificationRequest) {
  return {
    usage,
    candidate: {
      outcome: 'PASSED' as const,
      rationale: '合成判断：说明微任务清空规则。',
      suggestions: [],
      confidence: 0.8,
      citations: [{ startLine: 3, endLine: 3, excerpt: request.note.lines[2]! }],
      answerCitations: [{ startLine: 1, endLine: 1, excerpt: request.answer.content }],
    },
  }
}
async function fixture() {
  const f = await createNoteVerificationFixture(database, (value) => fixtures.push(value))
  // 复用真实笔记/出题 Processor 和 Finalizer，只有模型用合成响应。
  const note = new NoteVerificationJobProcessor(
    new NoteVerificationRunRepository(database, environment),
    new NoteVerificationExecutionRepository(database),
    {
      verify: async (request) => ({
        usage,
        candidate: {
          results: request.criteria.map((criterion) => ({
            criterionId: criterion.id,
            outcome: 'PASSED',
            rationale: '合成笔记结论',
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
          question: '微任务又加入微任务时，为什么仍先于下一宏任务？',
          rubric: ['说明微任务队列会清空。'],
          citations: [{ startLine: 3, endLine: 3, excerpt: request.note.lines[2]! }],
        },
      }),
    },
  )
  const report = await note.process(f.payload)
  const question = await database.followUpQuestion.findUniqueOrThrow({
    where: { reportId: report.reportId! },
  })
  const command = {
    requestId: randomUUID(),
    expectedTaskVersion: (await f.task()).version,
    answer: '微任务队列需要清空，再执行后续宏任务。',
  }
  const accepted = await new FollowUpAnswerService(database).submit(f.userId, question.id, command)
  const event = await database.outboxEvent.findUniqueOrThrow({
    where: { deduplicationKey: `answer-verification-requested-${accepted.runId}` },
  })
  return {
    ...f,
    noteRunId: f.runId,
    ...accepted,
    questionId: question.id,
    command,
    eventId: event.id,
    payload: { runId: accepted.runId, answerSubmissionId: accepted.answerSubmissionId },
    run: () =>
      database.agentRun.findUniqueOrThrow({
        where: { id: accepted.runId },
        include: { report: true, modelExecution: true },
      }),
  }
}
function processor(
  verify: AnswerVerificationPort['verify'],
  db: DatabaseClient = database,
  now = () => new Date(),
) {
  const scoped = db.$extends({
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
  const runs = new AnswerVerificationRunRepository(scoped, environment, now)
  const ledger = new VerificationExecutionRepository(
    db,
    'ANSWER_VERIFICATION',
    answerExecutionResultSchema,
  )
  return { runs, ledger, handler: new AnswerVerificationJobProcessor(runs, ledger, { verify }) }
}
async function transport(handler: Pick<AnswerVerificationJobProcessor, 'process'>) {
  const queueName = `r10-answer-fixture-${randomUUID()}`
  const queue = new BullMqAnswerVerificationQueue({
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
    const runs = await database.agentRun.findMany({
      where: { taskId: f.taskId },
      select: { id: true },
    })
    await database.outboxEvent.deleteMany({ where: { aggregateId: { in: runs.map((r) => r.id) } } })
    await database.agentRun.deleteMany({ where: { taskId: f.taskId, kind: 'ANSWER_VERIFICATION' } })
    await database.answerSubmission.deleteMany({
      where: { question: { report: { run: { taskId: f.taskId } } } },
    })
    await database.agentRun.deleteMany({ where: { taskId: f.taskId } })
    await database.submission.deleteMany({ where: { taskId: f.taskId } })
    await database.user.deleteMany({ where: { id: f.userId } })
    await database.gitHubInstallation.deleteMany({ where: { id: f.installationId } })
  }
})
afterAll(() => database.$disconnect())

describe('R10 answer consumer, durable budget and atomic report', () => {
  it('freezes reasoning effort at first claim and retains it after a configuration change', async () => {
    const f = await fixture()
    const configured = (reasoningEffort: 'low' | 'max') => ({
      ...environment,
      NOTE_VERIFICATION_MODEL_JSON: {
        ...environment.NOTE_VERIFICATION_MODEL_JSON!,
        reasoningEffort,
      },
    })
    const first = await new AnswerVerificationRunRepository(database, configured('low')).prepare(
      f.payload,
    )
    expect(first.ready).toBe(true)
    if (!first.ready) throw new Error('expected ready')
    expect(first.configuration.model.reasoningEffort).toBe('low')
    const resumed = await new AnswerVerificationRunRepository(database, configured('max')).prepare(
      f.payload,
    )
    expect(resumed).toEqual(first)
    expect((await f.run()).executionConfiguration).toMatchObject({
      model: { reasoningEffort: 'low' },
    })
  })

  it('runs a saved answer through outbox/BullMQ, returns an owner-only report and replays without another call', async () => {
    const f = await fixture()
    const verify = vi
      .fn<AnswerVerificationPort['verify']>()
      .mockImplementation(async (r) => response(r))
    const { handler } = processor(verify)
    const { queue, inspector, events } = await transport(handler)
    const dispatcher = new OutboxDispatcher(
      database,
      { publish: vi.fn(), publishAnswerVerification: (m) => queue.publish(m) },
      { baseDelayMs: 100, maxDelayMs: 1000 },
      () => new Date('2099-01-02'),
    )
    expect(await dispatcher.dispatchEvent(f.eventId)).toMatchObject({ status: 'DISPATCHED' })
    const job = await inspector.getJob(buildAnswerVerificationJobId(f.runId))
    expect(job?.data).toEqual(f.payload)
    queue.start()
    const result = await job!.waitUntilFinished(events, 10_000)
    expect(result).toMatchObject({ status: 'SUCCEEDED', reportId: expect.any(String) })
    const query = new FollowUpAnswerService(database)
    const view = await query.get(f.userId, f.answerSubmissionId)
    expect(view.run.status).toBe('SUCCEEDED')
    expect(view.report?.body).toMatchObject({
      source: { noteRunId: f.noteRunId, submissionId: f.submissionId },
      result: {
        outcome: 'PASSED',
        questionId: f.questionId,
        answerSubmissionId: f.answerSubmissionId,
      },
      accounting: { knownTotalTokens: 150, knownCostMicrounits: 2200, usageComplete: true },
    })
    expect(JSON.stringify(view)).not.toContain('rubric')
    await expect(query.get(randomUUID(), f.answerSubmissionId)).rejects.toMatchObject({
      status: 404,
    })
    expect(await handler.process(f.payload)).toEqual(result)
    expect(await query.submit(f.userId, f.questionId, f.command)).toMatchObject({ runId: f.runId })
    expect(verify).toHaveBeenCalledOnce()
    expect(await database.verificationReport.count({ where: { runId: f.runId } })).toBe(1)
    expect(await f.task()).toMatchObject({ state: 'PASSED', version: f.taskVersion + 1 })
  })

  it.each(['FAILED', 'INSUFFICIENT_EVIDENCE'] as const)(
    'persists %s as a valid report without passing or revising the Task',
    async (outcome) => {
      const f = await fixture()
      const { handler } = processor(async (r) => ({
        ...response(r),
        candidate: {
          ...response(r).candidate,
          outcome,
          suggestions: ['补充说明执行原因。'],
        },
      }))
      expect(await handler.process(f.payload)).toMatchObject({ status: 'SUCCEEDED' })
      expect(
        answerVerificationReportBodySchema.parse((await f.run()).report!.body).result.outcome,
      ).toBe(outcome)
      expect(await f.task()).toMatchObject({ state: 'NEEDS_EVIDENCE', version: f.taskVersion + 1 })
    },
  )

  it('rolls back report and Run together, then reconciles the saved result without calling the model again', async () => {
    const f = await fixture()
    let fail = true
    const faulty = database.$extends({
      query: {
        agentRun: {
          update({ args, query }) {
            if (args.data.status === 'SUCCEEDED' && fail) {
              fail = false
              throw new Error('fixture-report-outage')
            }
            return query(args)
          },
        },
      },
    }) as unknown as DatabaseClient
    const verify = vi
      .fn<AnswerVerificationPort['verify']>()
      .mockImplementation(async (r) => response(r))
    await expect(processor(verify, faulty).handler.process(f.payload)).rejects.toThrow(
      'fixture-report-outage',
    )
    expect(await f.run()).toMatchObject({
      status: 'RUNNING',
      report: null,
      modelExecution: { result: { status: 'SUCCEEDED' } },
    })
    expect(await f.task()).toMatchObject({ state: 'VERIFYING', version: f.taskVersion })
    // 即使队列访问出错，已保存结果的恢复也先在数据库完成。
    await processor(verify).runs.reconcile(100, async () => {
      throw new Error('fixture-redis-unavailable')
    })
    expect(await processor(verify).handler.process(f.payload)).toMatchObject({
      status: 'SUCCEEDED',
    })
    expect(verify).toHaveBeenCalledOnce()
    expect(await f.task()).toMatchObject({ state: 'PASSED', version: f.taskVersion + 1 })
  })

  it('does not complete a concurrent duplicate or reset the first claim budget', async () => {
    const f = await fixture()
    let release!: () => void, entered!: () => void
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const verify = vi.fn<AnswerVerificationPort['verify']>().mockImplementation(async (r) => {
      entered()
      await wait
      return response(r)
    })
    const { handler } = processor(verify)
    const first = handler.process(f.payload)
    try {
      await started
      await expect(handler.process(f.payload)).rejects.toThrow('ANSWER_EXECUTION_IN_PROGRESS')
      expect(await f.run()).toMatchObject({
        modelExecution: { attemptCount: 1, pendingAttempt: 1 },
      })
    } finally {
      release()
    }
    expect(await first).toMatchObject({ status: 'SUCCEEDED' })
    expect(verify).toHaveBeenCalledOnce()
  })

  it.each(['unbind', 'version', 'cancel', 'new-note'] as const)(
    'refuses late results after %s and preserves a newer Task state',
    async (change) => {
      const f = await fixture()
      const { handler } = processor(async (r) => {
        if (change === 'unbind')
          await database.repository.update({
            where: { id: f.repositoryId },
            data: { enabled: false },
          })
        if (change === 'version')
          await database.task.update({
            where: { id: f.taskId },
            data: { version: f.taskVersion + 1, state: 'IN_PROGRESS' },
          })
        if (change === 'cancel')
          await database.agentRun.update({
            where: { id: f.runId },
            data: { status: 'CANCEL_REQUESTED', version: { increment: 1 } },
          })
        if (change === 'new-note') {
          const old = await database.submission.findUniqueOrThrow({ where: { id: f.submissionId } })
          await database.submission.create({
            data: {
              ...old,
              id: randomUUID(),
              taskVersion: f.taskVersion,
              afterCommitSha: 'c'.repeat(40),
            },
          })
        }
        return response(r)
      })
      expect(await handler.process(f.payload)).toMatchObject({
        status: change === 'cancel' ? 'CANCELLED' : 'FAILED',
        reportId: null,
      })
      expect(await f.task()).toMatchObject({
        state: change === 'version' ? 'IN_PROGRESS' : 'NEEDS_EVIDENCE',
        version: f.taskVersion + 1,
      })
    },
  )

  it('rejects wrong answer IDs and stale eligibility before any model call', async () => {
    const f = await fixture()
    const verify = vi.fn<AnswerVerificationPort['verify']>()
    const { handler } = processor(verify)
    expect(await handler.process({ ...f.payload, answerSubmissionId: randomUUID() })).toMatchObject(
      { status: 'IGNORED' },
    )
    await database.repository.update({ where: { id: f.repositoryId }, data: { enabled: false } })
    expect(await handler.process(f.payload)).toMatchObject({ status: 'FAILED', reportId: null })
    expect(verify).not.toHaveBeenCalled()
  })

  it.each(['quote', 'identity', 'rubric', 'price'] as const)(
    'rejects a changed %s before publishing a saved result',
    async (change) => {
      const f = await fixture()
      const verify = vi
        .fn<AnswerVerificationPort['verify']>()
        .mockImplementation(async (r) => response(r))
      const { runs, ledger } = processor(verify)
      const prepared = await runs.prepare(f.payload)
      if (!prepared.ready) throw new Error('fixture-not-ready')
      await executePersistedAnswerVerification(
        ledger,
        { verify },
        prepared.input,
        {
          signal: new AbortController().signal,
          maxOutputTokens: prepared.configuration.maxOutputTokens,
        },
        prepared.configuration.budget,
      )
      if (change === 'quote' || change === 'identity') {
        const saved = answerExecutionResultSchema.parse((await f.run()).modelExecution!.result)
        if (saved.status !== 'SUCCEEDED') throw new Error('fixture-no-result')
        if (change === 'quote') saved.result.answerCitations[0]!.excerpt = '伪造解释'
        else saved.result.answerSubmissionId = randomUUID()
        await database.noteVerificationExecution.update({
          where: { runId: f.runId },
          data: { result: json(saved) },
        })
      } else if (change === 'rubric') {
        const question = await database.followUpQuestion.findUniqueOrThrow({
          where: { id: f.questionId },
        })
        await database.followUpQuestion.update({
          where: { id: question.id },
          data: { body: { ...(question.body as object), rubric: ['已改变的规则'] } },
        })
      } else {
        const config = structuredClone(prepared.configuration)
        config.budget.pricing.inputMicrounitsPerMillionTokens++
        await database.agentRun.update({
          where: { id: f.runId },
          data: { executionConfiguration: json(config) },
        })
      }
      expect(await runs.finalize(f.payload)).toMatchObject({ status: 'FAILED', reportId: null })
      expect(verify).toHaveBeenCalledOnce()
    },
  )

  it.each(['unknown', 'over-budget'] as const)(
    'keeps a valid answer result with %s accounting warnings',
    async (mode) => {
      const f = await fixture()
      const { handler } = processor(async (r) => ({
        ...response(r),
        usage:
          mode === 'unknown'
            ? null
            : {
                inputTokens: 200_000,
                outputTokens: 200_000,
                totalTokens: 400_000,
              },
      }))
      expect(await handler.process(f.payload)).toMatchObject({ status: 'SUCCEEDED' })
      const body = answerVerificationReportBodySchema.parse((await f.run()).report!.body)
      expect(body.result.outcome).toBe('PASSED')
      expect(body.accounting.warnings).toContain(
        mode === 'unknown' ? 'MODEL_USAGE_UNKNOWN' : 'MODEL_BUDGET_EXCEEDED',
      )
    },
  )

  it('repairs at most once inside one ledger and never starts a third model call on job replay', async () => {
    const f = await fixture()
    const verify = vi.fn<AnswerVerificationPort['verify']>().mockImplementation(async (r) => {
      const value = response(r)
      value.candidate.answerCitations[0]!.excerpt = '不存在的文字'
      return value
    })
    const { handler } = processor(verify)
    expect(await handler.process(f.payload)).toMatchObject({ status: 'FAILED' })
    expect(await handler.process(f.payload)).toMatchObject({ status: 'FAILED' })
    expect(verify).toHaveBeenCalledTimes(2)
    expect(await f.run()).toMatchObject({
      errorCode: 'MODEL_CALL_LIMIT_EXCEEDED',
      modelExecution: { attemptCount: 2 },
    })
    expect(await f.task()).toMatchObject({ state: 'NEEDS_EVIDENCE', version: f.taskVersion + 1 })
  })

  it('recovers an unfinished claim by timeout without repeating an unknown model call', async () => {
    const f = await fixture()
    const verify = vi.fn<AnswerVerificationPort['verify']>()
    const { runs, ledger, handler } = processor(verify)
    const prepared = await runs.prepare(f.payload)
    if (!prepared.ready) throw new Error('fixture-not-ready')
    // 模拟请求已经登记、但进程退出未保存整体结果：重放不得重新 claim。
    const { answerExecutionFingerprint } =
      await import('../src/verification/execute-persisted-answer-verification.js')
    await ledger.claim({
      runId: f.runId,
      taskId: f.taskId,
      fingerprint: answerExecutionFingerprint(prepared.input),
      configuration: prepared.configuration,
    })
    await expect(handler.process(f.payload)).rejects.toThrow('ANSWER_EXECUTION_IN_PROGRESS')
    await processor(verify, database, () => new Date(Date.now() + 60_000)).runs.reconcile(100)
    expect(await f.run()).toMatchObject({ status: 'TIMED_OUT', report: null })
    expect(verify).not.toHaveBeenCalled()
  })

  it('settles a real exhausted queue job after a database failure before first claim', async () => {
    const f = await fixture()
    const { queue, inspector, events } = await transport({
      process: async () => {
        throw new Error('private-database-error')
      },
    })
    await queue.publish({ eventId: f.eventId, payload: f.payload })
    const job = await inspector.getJob(buildAnswerVerificationJobId(f.runId))
    queue.start()
    await expect(job!.waitUntilFinished(events, 10_000)).rejects.toThrow(
      'ANSWER_VERIFICATION_RETRY_REQUIRED',
    )
    expect(await queue.isFailed({ ...f.payload, answerSubmissionId: randomUUID() })).toBe(false)
    const verify = vi.fn<AnswerVerificationPort['verify']>()
    await processor(verify).runs.reconcile(100, (m) => queue.isFailed(m))
    expect(await f.run()).toMatchObject({
      status: 'FAILED',
      errorCode: 'ANSWER_QUEUE_FAILED',
      modelExecution: null,
    })
    expect(await f.task()).toMatchObject({ state: 'NEEDS_EVIDENCE', version: f.taskVersion + 1 })
    expect(verify).not.toHaveBeenCalled()
  })
})
function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
}
