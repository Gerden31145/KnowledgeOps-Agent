import { randomUUID } from 'node:crypto'
import { createDatabaseClient, Prisma, type DatabaseClient } from '@knowledgeops/database'
import type { TaskState } from '@knowledgeops/contracts'
import type {
  AnswerVerificationPort,
  FollowUpGenerationPort,
  NoteVerificationPort,
} from '@knowledgeops/agent-core'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { FollowUpAnswerService } from '../../api/src/verification/follow-up-answer.service.js'
import { PlanLifecycleRepository } from '../../api/src/plans/plan-lifecycle.repository.js'
import { readWorkerEnvironment } from '../src/config/environment.js'
import { NoteVerificationRunRepository } from '../src/verification/note-verification-run.repository.js'
import { AnswerVerificationRunRepository } from '../src/verification/answer-verification-run.repository.js'
import {
  NoteVerificationExecutionRepository,
  VerificationExecutionRepository,
} from '../src/verification/note-verification-execution.repository.js'
import { NoteVerificationJobProcessor } from '../src/verification/note-verification-job-processor.js'
import { AnswerVerificationJobProcessor } from '../src/verification/answer-verification-job-processor.js'
import {
  answerExecutionResultSchema,
  executePersistedAnswerVerification,
} from '../src/verification/execute-persisted-answer-verification.js'
import { unlockDependentTasks } from '../src/verification/unlock-dependent-tasks.js'
import { createNoteVerificationFixture, type NoteFixtureIdentity } from './fixtures/verification.js'

// 真实本地事务，模型全为合成响应；延后 Outbox，避免其他终端的 Worker 领取测试任务。
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
const database = createDatabaseClient(environment.DATABASE_URL).$extends({
  query: {
    outboxEvent: {
      create({ args, query }) {
        return query({ ...args, data: { ...args.data, availableAt: new Date('2099-01-01') } })
      },
    },
  },
}) as unknown as DatabaseClient
const fixtures: NoteFixtureIdentity[] = []
const usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 }

function processors(db = database) {
  const verifyNote = vi
    .fn<NoteVerificationPort['verify']>()
    .mockImplementation(async (request) => ({
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
    }))
  const generate = vi
    .fn<FollowUpGenerationPort['generate']>()
    .mockImplementation(async (request) => ({
      usage,
      candidate: {
        question: '微任务再次加入微任务时，会何时执行？',
        rubric: ['说明微任务队列会继续清空。'],
        citations: [{ startLine: 3, endLine: 3, excerpt: request.note.lines[2]! }],
      },
    }))
  const verifyAnswer = vi
    .fn<AnswerVerificationPort['verify']>()
    .mockImplementation(async (request) => ({
      usage,
      candidate: {
        outcome: 'PASSED',
        rationale: '合成回答结论',
        suggestions: [],
        confidence: 0.8,
        citations: [{ startLine: 3, endLine: 3, excerpt: request.note.lines[2]! }],
        answerCitations: [{ startLine: 1, endLine: 1, excerpt: request.answer.content }],
      },
    }))
  return {
    verifyNote,
    generate,
    verifyAnswer,
    note: new NoteVerificationJobProcessor(
      new NoteVerificationRunRepository(db, environment),
      new NoteVerificationExecutionRepository(db),
      { verify: verifyNote },
      { generate },
    ),
    answer: new AnswerVerificationJobProcessor(
      new AnswerVerificationRunRepository(db, environment),
      new VerificationExecutionRepository(db, 'ANSWER_VERIFICATION', answerExecutionResultSchema),
      { verify: verifyAnswer },
    ),
  }
}
const fixture = () => createNoteVerificationFixture(database, (f) => fixtures.push(f))
async function submit(f: Awaited<ReturnType<typeof fixture>>, reportId: string, answer: string) {
  const question = await database.followUpQuestion.findUniqueOrThrow({ where: { reportId } })
  const accepted = await new FollowUpAnswerService(database).submit(f.userId, question.id, {
    requestId: randomUUID(),
    expectedTaskVersion: (await f.task()).version,
    answer,
  })
  return { runId: accepted.runId, answerSubmissionId: accepted.answerSubmissionId }
}
afterEach(async () => {
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

async function dependent(
  stageId: string,
  position: number,
  prerequisiteIds: string[],
  state: TaskState = 'BLOCKED',
) {
  return database.task.create({
    data: {
      stageId,
      position,
      state,
      title: `后续任务 ${position}`,
      description: 'R11 解锁夹具',
      estimatedMinutes: 15,
      prerequisites: {
        create: prerequisiteIds.map((prerequisiteTaskId) => ({ prerequisiteTaskId })),
      },
    },
  })
}
const stateOf = (id: string) =>
  database.task.findUniqueOrThrow({
    where: { id },
    select: { state: true, version: true },
  })
async function answerFixture() {
  const f = await fixture()
  const p = processors()
  const note = await p.note.process(f.payload)
  const payload = await submit(f, note.reportId!, '微任务队列需要清空，再执行后续宏任务。')
  return { f, p, payload, stageId: (await f.task()).stageId }
}

describe('R11 atomic report and Task publication', () => {
  it('waits for an answer, allows a corrected answer, and never republishes old terminal runs', async () => {
    const f = await fixture()
    const p = processors()
    const noteResult = await p.note.process(f.payload)
    expect(noteResult.status).toBe('SUCCEEDED')
    expect(await f.task()).toMatchObject({ state: 'NEEDS_EVIDENCE', version: 7 })

    const first = await submit(f, noteResult.reportId!, '合成回答：微任务要等下一轮。')
    expect(await f.task()).toMatchObject({ state: 'VERIFYING', version: 8 })
    const answerResponse = p.verifyAnswer.getMockImplementation()!
    p.verifyAnswer.mockImplementationOnce(async (request, options) => {
      const result = await answerResponse(request, options)
      return {
        ...result,
        candidate: {
          ...result.candidate,
          outcome: 'FAILED',
          suggestions: ['修正微任务执行时机。'],
        },
      }
    })
    const firstResult = await p.answer.process(first)
    expect(firstResult.status).toBe('SUCCEEDED')
    expect(await f.task()).toMatchObject({ state: 'NEEDS_EVIDENCE', version: 9 })

    const second = await submit(
      f,
      noteResult.reportId!,
      '修正回答：继续清空队列，再执行后续宏任务。',
    )
    expect(await f.task()).toMatchObject({ state: 'VERIFYING', version: 10 })
    expect((await p.answer.process(second)).status).toBe('SUCCEEDED')
    expect(await f.task()).toMatchObject({ state: 'PASSED', version: 11 })
    expect(await p.note.process(f.payload)).toEqual(noteResult)
    expect(await p.answer.process(first)).toEqual(firstResult)
    expect(await f.task()).toMatchObject({ state: 'PASSED', version: 11 })
    expect(p.verifyNote).toHaveBeenCalledOnce()
    expect(p.verifyAnswer).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['FAILED', 'NEEDS_REVISION'],
    ['INSUFFICIENT_EVIDENCE', 'NEEDS_EVIDENCE'],
  ] as const)('publishes a valid %s note report with Task %s', async (outcome, state) => {
    const f = await fixture()
    const p = processors()
    p.verifyNote.mockImplementation(async (request) => ({
      usage,
      candidate: {
        results: request.criteria.map((criterion) => ({
          criterionId: criterion.id,
          outcome,
          rationale: '合成未通过结论',
          suggestions: ['补充微任务解释'],
          confidence: 0.8,
          citations: [{ startLine: 3, endLine: 3, excerpt: request.note.lines[2]! }],
        })),
      },
    }))
    expect((await p.note.process(f.payload)).status).toBe('SUCCEEDED')
    expect(await f.task()).toMatchObject({ state, version: 7 })
    expect((await f.run()).report).not.toBeNull()
    expect(p.generate).not.toHaveBeenCalled()
  })

  it('rolls back report, question and Run when Task publication fails; retry reuses the ledger', async () => {
    const f = await fixture()
    const broken = database.$extends({
      query: {
        task: {
          update() {
            throw new Error('fixture-task-write-failed')
          },
        },
      },
    }) as unknown as DatabaseClient
    const p = processors(broken)
    await expect(p.note.process(f.payload)).rejects.toThrow('fixture-task-write-failed')
    expect(await f.task()).toMatchObject({ state: 'VERIFYING', version: 6 })
    expect(await f.run()).toMatchObject({
      status: 'RUNNING',
      report: null,
      modelExecution: { result: { status: 'SUCCEEDED' } },
    })
    expect(await database.followUpQuestion.count({ where: { report: { runId: f.runId } } })).toBe(0)
    const recovered = processors()
    expect((await recovered.note.process(f.payload)).status).toBe('SUCCEEDED')
    expect(await f.task()).toMatchObject({ state: 'NEEDS_EVIDENCE', version: 7 })
    expect(p.verifyNote).toHaveBeenCalledOnce()
    expect(p.generate).toHaveBeenCalledOnce()
    expect(recovered.verifyNote).not.toHaveBeenCalled()
    expect(recovered.generate).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'preserves a frozen legacy run without a required question (question step=%s)',
    async (step) => {
      const f = await fixture()
      const prepared = await new NoteVerificationRunRepository(database, environment).prepare(
        f.payload,
      )
      if (!prepared.ready) throw new Error('fixture-not-ready')
      // 模拟升级前已经 RUNNING、尚未调用模型的记录；生产代码不能更改其标准/冻结配置。
      await database.acceptanceCriterion.deleteMany({
        where: { taskId: f.taskId, type: 'FOLLOW_UP_ANSWER' },
      })
      const config = { ...prepared.configuration }
      if (!step) delete config.followUp
      await database.agentRun.update({
        where: { id: f.runId },
        data: { executionConfiguration: config as unknown as Prisma.InputJsonValue },
      })
      const before = await database.acceptanceCriterion.findMany({
        where: { taskId: f.taskId },
        orderBy: { position: 'asc' },
      })
      const p = processors()
      const result = await p.note.process(f.payload)
      expect(result.status).toBe('SUCCEEDED')
      expect((await f.run()).report).not.toBeNull()
      expect((await f.run()).executionConfiguration).toEqual(JSON.parse(JSON.stringify(config)))
      expect(await f.task()).toMatchObject({ state: 'IN_PROGRESS', version: 7 })
      expect(
        await database.acceptanceCriterion.findMany({
          where: { taskId: f.taskId },
          orderBy: { position: 'asc' },
        }),
      ).toEqual(before)
      expect(p.generate).not.toHaveBeenCalled()
      expect(await p.note.process(f.payload)).toEqual(result)
      expect(await f.task()).toMatchObject({ state: 'IN_PROGRESS', version: 7 })
    },
  )

  it('rejects a changed required criterion at answer publication without publishing a false pass', async () => {
    const f = await fixture()
    const p = processors()
    const noteResult = await p.note.process(f.payload)
    const payload = await submit(f, noteResult.reportId!, '微任务队列需要清空。')
    const answerResponse = p.verifyAnswer.getMockImplementation()!
    p.verifyAnswer.mockImplementation(async (request, options) => {
      await database.acceptanceCriterion.updateMany({
        where: { taskId: f.taskId, type: 'FOLLOW_UP_ANSWER' },
        data: { required: false },
      })
      return answerResponse(request, options)
    })
    expect((await p.answer.process(payload)).status).toBe('FAILED')
    expect(
      await database.agentRun.findUniqueOrThrow({
        where: { id: payload.runId },
        include: { report: true },
      }),
    ).toMatchObject({ errorCode: 'EXECUTION_CONTEXT_CHANGED', report: null })
    expect(await f.task()).toMatchObject({ state: 'NEEDS_EVIDENCE', version: 9 })
    expect((await f.run()).report?.id).toBe(noteResult.reportId)
  })
})

describe('R11 dependent Task unlocking', () => {
  it('unlocks direct dependents after an answer passes, leaves the next layer blocked, and lets the user start one', async () => {
    const f = await fixture()
    const stageId = (await f.task()).stageId
    const stage = await database.stage.findUniqueOrThrow({ where: { id: stageId } })
    const nextStage = await database.stage.create({
      data: { planId: stage.planId, position: 1, title: '同一计划的下一阶段' },
    })
    const b = await dependent(stageId, 1, [f.taskId])
    const c = await dependent(stageId, 2, [b.id])
    const d = await dependent(nextStage.id, 0, [f.taskId])
    const p = processors()
    const note = await p.note.process(f.payload)
    expect(await stateOf(b.id)).toEqual({ state: 'BLOCKED', version: 0 })
    const payload = await submit(f, note.reportId!, '微任务队列需要清空。')
    const result = await p.answer.process(payload)
    expect(result.status).toBe('SUCCEEDED')
    expect(await stateOf(f.taskId)).toEqual({ state: 'PASSED', version: 9 })
    expect(await stateOf(b.id)).toEqual({ state: 'READY', version: 1 })
    expect(await stateOf(d.id)).toEqual({ state: 'READY', version: 1 })
    expect(await stateOf(c.id)).toEqual({ state: 'BLOCKED', version: 0 })

    const started = await new PlanLifecycleRepository(database).startTask(b.id, f.userId, {
      targetPath: 'notes/next.md',
    })
    expect(started).toMatchObject({ state: 'IN_PROGRESS', version: 2 })
    expect(await p.answer.process(payload)).toEqual(result)
    expect(await stateOf(b.id)).toEqual({ state: 'IN_PROGRESS', version: 2 })
    expect(await stateOf(d.id)).toEqual({ state: 'READY', version: 1 })
    expect(p.verifyAnswer).toHaveBeenCalledOnce()
  })

  it('waits for all prerequisites and excludes unrelated, non-blocked and cross-plan tasks', async () => {
    const { f, p, payload, stageId } = await answerFixture()
    const other = await fixture()
    await database.task.update({ where: { id: other.taskId }, data: { state: 'PASSED' } })
    const x = await dependent(stageId, 1, [], 'READY')
    const b = await dependent(stageId, 2, [f.taskId, x.id])
    const unrelated = await dependent(stageId, 3, [])
    // 仅用于防御边界的异常图：不允许跨计划关系或重复检查重置已有状态。
    const foreignPrerequisite = await dependent(stageId, 4, [f.taskId, other.taskId])
    const foreignDependent = await dependent((await other.task()).stageId, 1, [f.taskId])
    const alreadyReady = await dependent(stageId, 5, [f.taskId], 'READY')
    const alreadyPassed = await dependent(stageId, 6, [f.taskId], 'PASSED')
    expect((await p.answer.process(payload)).status).toBe('SUCCEEDED')
    for (const task of [b, unrelated, foreignPrerequisite, foreignDependent])
      expect(await stateOf(task.id)).toEqual({ state: 'BLOCKED', version: 0 })
    expect(await stateOf(alreadyReady.id)).toEqual({ state: 'READY', version: 0 })
    expect(await stateOf(alreadyPassed.id)).toEqual({ state: 'PASSED', version: 0 })

    const stage = await database.stage.findUniqueOrThrow({ where: { id: stageId } })
    // 在隔离夹具中模拟另一前置 X 已验收通过；采用调用方的同一用户锁和事务。
    await database.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM users WHERE id = ${f.userId}::uuid FOR UPDATE`)
      await tx.task.update({
        where: { id: x.id },
        data: { state: 'PASSED', version: { increment: 1 } },
      })
      await unlockDependentTasks(tx, x.id, stage.planId)
      await unlockDependentTasks(tx, f.taskId, stage.planId)
    })
    expect(await stateOf(b.id)).toEqual({ state: 'READY', version: 1 })
    for (const task of [unrelated, foreignPrerequisite, foreignDependent])
      expect(await stateOf(task.id)).toEqual({ state: 'BLOCKED', version: 0 })
    expect(await stateOf(alreadyReady.id)).toEqual({ state: 'READY', version: 0 })
    expect(await stateOf(alreadyPassed.id)).toEqual({ state: 'PASSED', version: 0 })
  })

  it('publishes concurrent finalizers once without increasing dependent versions twice', async () => {
    const { f, p, payload, stageId } = await answerFixture()
    const b = await dependent(stageId, 1, [f.taskId])
    const runs = new AnswerVerificationRunRepository(database, environment)
    const prepared = await runs.prepare(payload)
    if (!prepared.ready) throw new Error('fixture-not-ready')
    await executePersistedAnswerVerification(
      new VerificationExecutionRepository(
        database,
        'ANSWER_VERIFICATION',
        answerExecutionResultSchema,
      ),
      { verify: p.verifyAnswer },
      prepared.input,
      {
        signal: new AbortController().signal,
        maxOutputTokens: prepared.configuration.maxOutputTokens,
      },
      prepared.configuration.budget,
    )
    const results = await Promise.all([runs.finalize(payload), runs.finalize(payload)])
    expect(results[0]).toMatchObject({ status: 'SUCCEEDED' })
    expect(results[1]).toEqual(results[0])
    expect(await stateOf(f.taskId)).toEqual({ state: 'PASSED', version: 9 })
    expect(await stateOf(b.id)).toEqual({ state: 'READY', version: 1 })
    expect(await database.verificationReport.count({ where: { runId: payload.runId } })).toBe(1)
    expect(p.verifyAnswer).toHaveBeenCalledOnce()
  })

  it.each(['FAILED', 'INSUFFICIENT_EVIDENCE'] as const)(
    'does not unlock after a valid %s answer report',
    async (outcome) => {
      const { f, p, payload, stageId } = await answerFixture()
      const b = await dependent(stageId, 1, [f.taskId])
      const response = p.verifyAnswer.getMockImplementation()!
      p.verifyAnswer.mockImplementation(async (request, options) => {
        const result = await response(request, options)
        return {
          ...result,
          candidate: { ...result.candidate, outcome, suggestions: ['补充微任务执行原因。'] },
        }
      })
      expect((await p.answer.process(payload)).status).toBe('SUCCEEDED')
      expect(await stateOf(f.taskId)).toEqual({ state: 'NEEDS_EVIDENCE', version: 9 })
      expect(await stateOf(b.id)).toEqual({ state: 'BLOCKED', version: 0 })
    },
  )

  it.each(['version', 'unbind'] as const)(
    'does not unlock when a passing answer arrives after %s changed',
    async (change) => {
      const { f, p, payload, stageId } = await answerFixture()
      const b = await dependent(stageId, 1, [f.taskId])
      const response = p.verifyAnswer.getMockImplementation()!
      p.verifyAnswer.mockImplementation(async (request, options) => {
        if (change === 'version')
          await database.task.update({
            where: { id: f.taskId },
            data: { state: 'IN_PROGRESS', version: { increment: 1 } },
          })
        else
          await database.repository.update({
            where: { id: f.repositoryId },
            data: { enabled: false },
          })
        return response(request, options)
      })
      expect((await p.answer.process(payload)).status).toBe('FAILED')
      expect(await stateOf(f.taskId)).toEqual({
        state: change === 'version' ? 'IN_PROGRESS' : 'NEEDS_EVIDENCE',
        version: 9,
      })
      expect(await stateOf(b.id)).toEqual({ state: 'BLOCKED', version: 0 })
      expect(await database.verificationReport.count({ where: { runId: payload.runId } })).toBe(0)
    },
  )

  it('rolls back source completion and dependent unlock together; retry reuses the saved answer', async () => {
    const { f, p, payload, stageId } = await answerFixture()
    const b = await dependent(stageId, 1, [f.taskId])
    const faulty = database.$extends({
      query: {
        task: {
          async updateMany({ args, query }) {
            const result = await query(args)
            // 写入已执行但尚未提交，模拟发布事务随后失败，验证解锁本身也回滚。
            if (args.data.state === 'READY') throw new Error('fixture-unlock-outage')
            return result
          },
        },
      },
    }) as unknown as DatabaseClient
    const broken = processors(faulty)
    await expect(broken.answer.process(payload)).rejects.toThrow('fixture-unlock-outage')
    expect(await stateOf(f.taskId)).toEqual({ state: 'VERIFYING', version: 8 })
    expect(await stateOf(b.id)).toEqual({ state: 'BLOCKED', version: 0 })
    expect(
      await database.agentRun.findUniqueOrThrow({
        where: { id: payload.runId },
        include: { report: true, modelExecution: true },
      }),
    ).toMatchObject({
      status: 'RUNNING',
      report: null,
      modelExecution: { result: { status: 'SUCCEEDED' } },
    })
    expect((await p.answer.process(payload)).status).toBe('SUCCEEDED')
    expect(await stateOf(f.taskId)).toEqual({ state: 'PASSED', version: 9 })
    expect(await stateOf(b.id)).toEqual({ state: 'READY', version: 1 })
    expect(broken.verifyAnswer).toHaveBeenCalledOnce()
    expect(p.verifyAnswer).not.toHaveBeenCalled()
  })
})
