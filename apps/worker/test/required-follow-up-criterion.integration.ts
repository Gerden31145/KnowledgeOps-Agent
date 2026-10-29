import { createDatabaseClient, Prisma, type DatabaseClient } from '@knowledgeops/database'
import type { FollowUpGenerationPort, NoteVerificationPort } from '@knowledgeops/agent-core'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { readWorkerEnvironment } from '../src/config/environment.js'
import { NoteVerificationRunRepository } from '../src/verification/note-verification-run.repository.js'
import { NoteVerificationExecutionRepository } from '../src/verification/note-verification-execution.repository.js'
import { NoteVerificationJobProcessor } from '../src/verification/note-verification-job-processor.js'
import { createNoteVerificationFixture, type NoteFixtureIdentity } from './fixtures/verification.js'

// 只创建随机 ID 的本地测试资料；真实数据库、合成模型响应，无供应商调用。
const environment = readWorkerEnvironment({
  ...process.env,
  OPENAI_API_KEY: 'fixture-not-a-real-key',
  NOTE_VERIFICATION_TIMEOUT_MS: '30000',
  NOTE_VERIFICATION_MODEL_JSON: JSON.stringify({
    catalogId: 'r11-fixture',
    modelName: 'fixture-model',
    currency: 'CNY',
    inputMicrounitsPerMillionTokens: 8_000_000,
    outputMicrounitsPerMillionTokens: 28_000_000,
  }),
})
const database = createDatabaseClient(environment.DATABASE_URL)
const fixtures: NoteFixtureIdentity[] = []
const runs = new NoteVerificationRunRepository(database, environment)
const fixture = () => createNoteVerificationFixture(database, (f) => fixtures.push(f))
const criteria = (taskId: string) =>
  database.acceptanceCriterion.findMany({
    where: { taskId },
    orderBy: { position: 'asc' },
  })
async function legacyFixture() {
  const f = await fixture()
  await database.acceptanceCriterion.deleteMany({
    where: { taskId: f.taskId, type: 'FOLLOW_UP_ANSWER' },
  })
  return f
}

afterEach(async () => {
  for (const f of fixtures.splice(0).reverse()) {
    await database.outboxEvent.deleteMany({ where: { id: f.eventId } })
    await database.agentRun.deleteMany({ where: { taskId: f.taskId } })
    await database.submission.deleteMany({ where: { taskId: f.taskId } })
    await database.user.deleteMany({ where: { id: f.userId } })
    await database.gitHubInstallation.deleteMany({ where: { id: f.installationId } })
  }
})
afterAll(() => database.$disconnect())

describe('R11 server-owned required follow-up criterion', () => {
  it('repairs a legacy task once before freezing a new run, including concurrent prepare', async () => {
    const f = await legacyFixture()
    const before = await criteria(f.taskId)
    const [first, second] = await Promise.all([runs.prepare(f.payload), runs.prepare(f.payload)])
    if (!first.ready || !second.ready) throw new Error('fixture-not-ready')
    const saved = await criteria(f.taskId)
    expect(saved.slice(0, -1)).toEqual(before)
    expect(saved).toHaveLength(before.length + 1)
    expect(saved.at(-1)).toMatchObject({
      type: 'FOLLOW_UP_ANSWER',
      required: true,
      position: 3,
      config: null,
    })
    expect(first.input.followUp?.criterion.id).toBe(saved.at(-1)!.id)
    expect(second.input).toEqual(first.input)
    expect(second.configuration).toEqual(first.configuration)
    expect(await runs.prepare(f.payload)).toEqual(first)
    expect(await criteria(f.taskId)).toEqual(saved)
    expect(await f.task()).toMatchObject({ state: 'VERIFYING', version: 6 })
  })

  it('uses the repaired criterion to generate and persist a question for that same note', async () => {
    const f = await legacyFixture()
    const usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 }
    const verify = vi.fn<NoteVerificationPort['verify']>().mockImplementation(async (request) => ({
      usage,
      candidate: {
        results: request.criteria.map((criterion) => ({
          criterionId: criterion.id,
          outcome: 'PASSED',
          confidence: 1,
          rationale: '合成笔记解释正确。',
          suggestions: [],
          citations: [{ startLine: 3, endLine: 3, excerpt: request.note.lines[2]! }],
        })),
      },
    }))
    const generate = vi
      .fn<FollowUpGenerationPort['generate']>()
      .mockImplementation(async (request) => ({
        usage,
        candidate: {
          question: '清空微任务队列期间又加入一个微任务，会何时执行？',
          rubric: ['解释队列继续清空后再进入下一个宏任务。'],
          citations: [{ startLine: 3, endLine: 3, excerpt: request.note.lines[2]! }],
        },
      }))
    const processor = new NoteVerificationJobProcessor(
      runs,
      new NoteVerificationExecutionRepository(database),
      { verify },
      { generate },
    )
    const result = await processor.process(f.payload)
    expect(result.status).toBe('SUCCEEDED')
    const required = (await criteria(f.taskId)).find((c) => c.type === 'FOLLOW_UP_ANSWER')!
    const question = await database.followUpQuestion.findUniqueOrThrow({
      where: { reportId: result.reportId! },
    })
    expect(question.body).toMatchObject({
      criterionId: required.id,
      source: { taskId: f.taskId, submissionId: f.submissionId, noteRunId: f.runId },
    })
    expect(await processor.process(f.payload)).toEqual(result)
    expect(verify).toHaveBeenCalledOnce()
    expect(generate).toHaveBeenCalledOnce()
    expect(await f.task()).toMatchObject({ state: 'NEEDS_EVIDENCE', version: 7 })
  })

  it.each(['optional', 'duplicate'] as const)(
    'rejects an existing %s question criterion without rewriting it',
    async (kind) => {
      const f = await fixture()
      if (kind === 'optional') {
        await database.acceptanceCriterion.updateMany({
          where: { taskId: f.taskId, type: 'FOLLOW_UP_ANSWER' },
          data: { required: false },
        })
      } else {
        await database.acceptanceCriterion.create({
          data: {
            taskId: f.taskId,
            type: 'FOLLOW_UP_ANSWER',
            required: true,
            position: 4,
            description: '重复夹具',
          },
        })
      }
      const before = await criteria(f.taskId)
      expect(await runs.prepare(f.payload)).toMatchObject({
        ready: false,
        result: { status: 'FAILED' },
      })
      expect(await criteria(f.taskId)).toEqual(before)
      expect(await f.run()).toMatchObject({ errorCode: 'INVALID_EVIDENCE', modelExecution: null })
    },
  )

  it('checks task eligibility before repairing a stale queued run', async () => {
    const f = await legacyFixture()
    await database.task.update({ where: { id: f.taskId }, data: { version: { increment: 1 } } })
    const before = await criteria(f.taskId)
    expect(await runs.prepare(f.payload)).toMatchObject({
      ready: false,
      result: { status: 'FAILED' },
    })
    expect(await criteria(f.taskId)).toEqual(before)
    expect(await f.run()).toMatchObject({ errorCode: 'TASK_CONTEXT_CHANGED', modelExecution: null })
    expect(await f.task()).toMatchObject({ state: 'VERIFYING', version: 7 })
  })

  it.each([false, true])(
    'keeps a frozen legacy run unchanged (question configuration: %s)',
    async (hasQuestionConfiguration) => {
      const f = await fixture()
      const existing = await criteria(f.taskId)
      const prepared = await runs.prepare(f.payload)
      if (!prepared.ready) throw new Error('fixture-not-ready')
      expect(await criteria(f.taskId)).toEqual(existing)
      // 模拟已冻结的 R09/R10 Run：可能有出题配置，但任务都缺少追问标准。
      const legacy = { ...prepared.configuration }
      if (!hasQuestionConfiguration) delete legacy.followUp
      await database.acceptanceCriterion.deleteMany({
        where: { taskId: f.taskId, type: 'FOLLOW_UP_ANSWER' },
      })
      await database.agentRun.update({
        where: { id: f.runId },
        data: {
          executionConfiguration: JSON.parse(JSON.stringify(legacy)) as Prisma.InputJsonValue,
        },
      })
      const originalRun = await f.run()
      const originalCriteria = await criteria(f.taskId)
      const repeated = await runs.prepare(f.payload)
      if (!repeated.ready) throw new Error('fixture-not-ready')
      expect(repeated.input.followUp).toBeUndefined()
      expect(repeated.input.criteria.some((c) => c.type === 'FOLLOW_UP_ANSWER')).toBe(false)
      expect(await f.run()).toEqual(originalRun)
      expect(await criteria(f.taskId)).toEqual(originalCriteria)
      // 历史终态重放也不能悄悄补齐标准。
      await database.agentRun.update({
        where: { id: f.runId },
        data: { status: 'SUCCEEDED', finishedAt: new Date() },
      })
      expect(await runs.prepare(f.payload)).toMatchObject({
        ready: false,
        result: { status: 'SUCCEEDED' },
      })
      expect(await criteria(f.taskId)).toEqual(originalCriteria)
    },
  )

  it('does not reset a frozen configuration merely because a run says QUEUED', async () => {
    const f = await fixture()
    const prepared = await runs.prepare(f.payload)
    if (!prepared.ready) throw new Error('fixture-not-ready')
    await database.acceptanceCriterion.deleteMany({
      where: { taskId: f.taskId, type: 'FOLLOW_UP_ANSWER' },
    })
    await database.agentRun.update({ where: { id: f.runId }, data: { status: 'QUEUED' } })
    const before = await f.run()
    const originalCriteria = await criteria(f.taskId)
    expect(await runs.prepare(f.payload)).toMatchObject({
      ready: false,
      result: { status: 'FAILED' },
    })
    expect(await f.run()).toMatchObject({
      errorCode: 'EXECUTION_CONTEXT_CHANGED',
      executionConfiguration: before.executionConfiguration,
    })
    expect(await criteria(f.taskId)).toEqual(originalCriteria)
  })

  it('rolls back the repaired criterion when starting the run fails', async () => {
    const f = await legacyFixture()
    const originalRun = await f.run()
    const originalCriteria = await criteria(f.taskId)
    const failing = database.$extends({
      query: {
        agentRun: {
          async update({ args, query }) {
            if (args.data.status === 'RUNNING') throw new Error('fixture-start-failed')
            return query(args)
          },
        },
      },
    }) as unknown as DatabaseClient
    await expect(
      new NoteVerificationRunRepository(failing, environment).prepare(f.payload),
    ).rejects.toThrow('fixture-start-failed')
    expect(await f.run()).toEqual(originalRun)
    expect(await criteria(f.taskId)).toEqual(originalCriteria)
  })
})
