import 'reflect-metadata'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import { createDatabaseClient, type DatabaseClient } from '@knowledgeops/database'
import {
  followUpAnswerAcceptedResponseSchema,
  followUpAnswerResponseSchema,
} from '@knowledgeops/contracts'
import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module.js'
import { API_ENVIRONMENT } from '../src/config/config.module.js'
import { readApiEnvironment } from '../src/config/environment.js'
import { DatabaseService } from '../src/database/database.service.js'
import { hashToken, opaqueToken } from '../src/identity/auth-http.js'

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
const environment = readApiEnvironment({
  DATABASE_URL: process.env.DATABASE_URL,
  NODE_ENV: 'test',
  WEB_ORIGIN: 'http://127.0.0.1:3000',
})
let rejectOutbox = false
const database = createDatabaseClient(environment.DATABASE_URL).$extends({
  query: {
    outboxEvent: {
      create({ args, query }) {
        if (rejectOutbox && args.data.type === 'ANSWER_VERIFICATION_REQUESTED')
          throw new Error('fixture-private-outbox-error')
        // 只隔离本测试创建的待办，避免被另一终端的 Worker 消费。
        return query({ ...args, data: { ...args.data, availableAt: new Date('2099-01-01') } })
      },
    },
  },
}) as unknown as DatabaseClient
let app: INestApplication
let baseUrl: string
let f: Awaited<ReturnType<typeof fixture>>
const createdFixtures: {
  userId: string
  otherId: string
  taskId: string
  questionId: string
  installationId: string
}[] = []

async function fixture() {
  const userId = randomUUID(),
    otherId = randomUUID(),
    taskId = randomUUID(),
    planId = randomUUID()
  const repositoryId = randomUUID(),
    submissionId = randomUUID(),
    noteRunId = randomUUID(),
    reportId = randomUUID(),
    questionId = randomUUID(),
    criterionId = randomUUID()
  const installationId = String(randomInt(8_000_000_000_000, 9_000_000_000_000))
  createdFixtures.push({ userId, otherId, taskId, questionId, installationId })
  const token = opaqueToken(),
    otherToken = opaqueToken()
  await database.user.create({
    data: {
      id: userId,
      githubLogin: 'r10-fixture',
      goals: {
        create: {
          title: 'R10 fixture',
          currentLevel: 'fixture',
          weeklyMinutes: 120,
          deadline: new Date('2026-12-31'),
          plans: {
            create: {
              id: planId,
              status: 'ACTIVE',
              stages: {
                create: {
                  title: 'fixture',
                  position: 0,
                  tasks: {
                    create: {
                      id: taskId,
                      title: '事件循环',
                      description: '解释执行顺序',
                      position: 0,
                      estimatedMinutes: 30,
                      state: 'VERIFYING',
                      version: 6,
                      targetPath: 'notes/event-loop.md',
                      criteria: {
                        create: {
                          id: criterionId,
                          type: 'FOLLOW_UP_ANSWER',
                          description: '回答顺序问题',
                          position: 0,
                        },
                      },
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
  await database.user.create({ data: { id: otherId, githubLogin: 'r10-other' } })
  await database.session.createMany({
    data: [
      { tokenHash: hashToken(token), userId, expiresAt: new Date(Date.now() + 300_000) },
      {
        tokenHash: hashToken(otherToken),
        userId: otherId,
        expiresAt: new Date(Date.now() + 300_000),
      },
    ],
  })
  await database.gitHubInstallation.create({
    data: { id: installationId, accountId: '42', accountLogin: 'fixture', verifiedAt: new Date() },
  })
  await database.repository.create({
    data: {
      id: repositoryId,
      userId,
      installationId,
      githubRepositoryId: installationId,
      fullName: 'fixture/notes',
      branch: 'main',
      defaultBranch: 'main',
      isPrivate: true,
    },
  })
  const content = '当前任务结束后，先清空微任务队列。'
  const contentHash = createHash('sha256').update(content).digest('hex')
  await database.submission.create({
    data: {
      id: submissionId,
      repositoryId,
      taskId,
      taskVersion: 5,
      beforeCommitSha: 'a'.repeat(40),
      afterCommitSha: 'b'.repeat(40),
      targetPath: 'notes/event-loop.md',
      workflowVersion: 'note-v1',
      evidence: {
        create: {
          content,
          contentHash,
          lineCount: 1,
          sourceCommitSha: 'b'.repeat(40),
          mode: 'DIFF',
          change: 'modified',
          diff: `@@ -0,0 +1 @@\n+${content}`,
        },
      },
    },
  })
  const source = {
    taskId,
    submissionId,
    noteRunId,
    reportId,
    repositoryId,
    commitSha: 'b'.repeat(40),
    path: 'notes/event-loop.md',
    contentHash,
  }
  const body = {
    question: '微任务中再加入微任务，会怎样？',
    rubric: ['先清空微任务再进入下一宏任务。'],
    criterionId,
    source,
    citations: [
      {
        repositoryId,
        commitSha: source.commitSha,
        path: source.path,
        contentHash,
        startLine: 1,
        endLine: 1,
        excerpt: content,
      },
    ],
  }
  // 本组只测试受理：使用合成的已完成笔记报告/题目，生成链路由 R09/R10 消费者集成覆盖。
  await database.agentRun.create({
    data: {
      id: noteRunId,
      taskId,
      submissionId,
      kind: 'NOTE_VERIFICATION',
      status: 'SUCCEEDED',
      taskStateBeforeRun: 'IN_PROGRESS',
      expectedTaskVersion: 6,
      workflowVersion: 'note-v1',
      report: {
        create: {
          id: reportId,
          body: {
            results: [],
            exemptions: [],
            pendingCriterionIds: [criterionId],
            followUp: { status: 'READY' },
            accounting: {
              knownTotalTokens: 100,
              knownCostMicrounits: 2000,
              currency: 'CNY',
              usageComplete: true,
              warnings: [],
            },
          },
          followUpQuestion: { create: { id: questionId, body } },
        },
      },
    },
  })
  return {
    userId,
    otherId,
    taskId,
    planId,
    repositoryId,
    submissionId,
    noteRunId,
    reportId,
    questionId,
    installationId,
    token,
    otherToken,
    body,
  }
}

const command = () => ({
  requestId: randomUUID(),
  expectedTaskVersion: 6,
  answer: '新加入的微任务继续执行，清空后才处理下一个宏任务。',
})
const headers = (token = f.token) => ({
  cookie: `knowledgeops_session=${token}`,
  origin: environment.WEB_ORIGIN,
  'content-type': 'application/json',
})
const post = (input: unknown, token = f.token, questionId = f.questionId) =>
  fetch(`${baseUrl}/follow-up-questions/${questionId}/answers`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify(input),
  })
async function accepted(input = command()) {
  const response = await post(input)
  expect(response.status).toBe(202)
  return followUpAnswerAcceptedResponseSchema.parse(await response.json())
}
const counts = async () => ({
  answers: await database.answerSubmission.count({ where: { questionId: f.questionId } }),
  runs: await database.agentRun.count({ where: { taskId: f.taskId, kind: 'ANSWER_VERIFICATION' } }),
  outbox: await database.outboxEvent.count({
    where: {
      type: 'ANSWER_VERIFICATION_REQUESTED',
      aggregateId: {
        in: (
          await database.agentRun.findMany({ where: { taskId: f.taskId }, select: { id: true } })
        ).map((r) => r.id),
      },
    },
  }),
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
  f = await fixture()
})
afterEach(async () => {
  for (const f of createdFixtures.splice(0).reverse()) {
    const runs = await database.agentRun.findMany({
      where: { taskId: f.taskId },
      select: { id: true },
    })
    await database.outboxEvent.deleteMany({ where: { aggregateId: { in: runs.map((r) => r.id) } } })
    await database.agentRun.deleteMany({ where: { taskId: f.taskId, kind: 'ANSWER_VERIFICATION' } })
    await database.answerSubmission.deleteMany({ where: { questionId: f.questionId } })
    await database.agentRun.deleteMany({ where: { taskId: f.taskId } })
    await database.submission.deleteMany({ where: { taskId: f.taskId } })
    await database.user.deleteMany({ where: { id: { in: [f.userId, f.otherId] } } })
    await database.gitHubInstallation.deleteMany({ where: { id: f.installationId } })
  }
})
afterAll(async () => {
  await app?.close()
  await database.$disconnect()
})

describe('R10 authenticated answer intake and atomic outbox', () => {
  it('accepts one answer with an independent Run, permits owner refresh and stores the outbox intent', async () => {
    const input = command()
    const result = await accepted(input)
    expect(result).toMatchObject({ taskId: f.taskId, taskVersion: 7 })
    expect(result.runId).not.toBe(f.noteRunId)
    expect(await database.agentRun.findUnique({ where: { id: result.runId } })).toMatchObject({
      kind: 'ANSWER_VERIFICATION',
      status: 'QUEUED',
      answerSubmissionId: result.answerSubmissionId,
      submissionId: null,
      expectedTaskVersion: 7,
      taskStateBeforeRun: 'NEEDS_EVIDENCE',
    })
    expect(await counts()).toEqual({ answers: 1, runs: 1, outbox: 1 })
    const response = await fetch(`${baseUrl}/answer-submissions/${result.answerSubmissionId}`, {
      headers: headers(),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const visible = followUpAnswerResponseSchema.parse(await response.json())
    expect(visible).toMatchObject({
      answer: input.answer,
      questionId: f.questionId,
      run: { runId: result.runId, status: 'QUEUED' },
    })
    expect(JSON.stringify(visible)).not.toContain('rubric')
    const event = await database.outboxEvent.findUniqueOrThrow({
      where: { deduplicationKey: `answer-verification-requested-${result.runId}` },
    })
    expect(event.payload).toEqual({
      runId: result.runId,
      answerSubmissionId: result.answerSubmissionId,
    })
    expect(await database.outboxEvent.findUnique({ where: { id: event.id } })).toMatchObject({
      dispatchedAt: null,
      deadLetteredAt: null,
    })
  })

  it('serializes concurrent same-request submissions and replays the original receipt after state changes', async () => {
    const input = command()
    const responses = await Promise.all([post(input), post(input)])
    expect(responses.map((r) => r.status)).toEqual([202, 202])
    const first = followUpAnswerAcceptedResponseSchema.parse(await responses[0]!.json())
    expect(await responses[1]!.json()).toEqual(first)
    await database.agentRun.update({ where: { id: first.runId }, data: { status: 'FAILED' } })
    await database.task.update({
      where: { id: f.taskId },
      data: { state: 'NEEDS_EVIDENCE', version: 8 },
    })
    expect(await accepted(input)).toEqual(first)
    expect(await counts()).toEqual({ answers: 1, runs: 1, outbox: 1 })
    expect((await database.task.findUniqueOrThrow({ where: { id: f.taskId } })).version).toBe(8)
  })

  it('rejects reuse of a request ID for changed content or version and blocks another active answer', async () => {
    const input = command()
    await accepted(input)
    for (const changed of [
      { ...input, answer: '另外一个答案' },
      { ...input, expectedTaskVersion: 7 },
      { ...command(), expectedTaskVersion: 7 },
    ]) {
      expect((await post(changed)).status).toBe(409)
    }
    expect(await counts()).toEqual({ answers: 1, runs: 1, outbox: 1 })
  })

  it('creates a new immutable answer after a prior attempt fails and the task is waiting again', async () => {
    const first = await accepted()
    await database.agentRun.update({ where: { id: first.runId }, data: { status: 'FAILED' } })
    await database.task.update({
      where: { id: f.taskId },
      data: { state: 'NEEDS_EVIDENCE', version: 8 },
    })
    const next = await accepted({
      ...command(),
      expectedTaskVersion: 8,
      answer: '补充原因：微任务检查点会持续处理队列，直到队列为空。',
    })
    expect(next.answerSubmissionId).not.toBe(first.answerSubmissionId)
    expect(next.runId).not.toBe(first.runId)
    expect(next.taskVersion).toBe(9)
    expect(await counts()).toEqual({ answers: 2, runs: 2, outbox: 2 })
  })

  it('enforces real cookie authentication, same-origin mutations and owner-only reads/writes', async () => {
    expect((await post(command(), '')).status).toBe(401)
    for (const origin of [undefined, 'https://foreign.example']) {
      const response = await fetch(`${baseUrl}/follow-up-questions/${f.questionId}/answers`, {
        method: 'POST',
        headers: {
          cookie: `knowledgeops_session=${f.token}`,
          'content-type': 'application/json',
          ...(origin ? { origin } : {}),
        },
        body: JSON.stringify(command()),
      })
      expect(response.status).toBe(403)
    }
    const foreign = await post(command(), f.otherToken)
    const missing = await post(command(), f.otherToken, randomUUID())
    expect(foreign.status).toBe(404)
    expect(await foreign.json()).toEqual(await missing.json())
    const result = await accepted()
    expect(
      (
        await fetch(`${baseUrl}/answer-submissions/${result.answerSubmissionId}`, {
          headers: headers(f.otherToken),
        })
      ).status,
    ).toBe(404)
    expect(await counts()).toEqual({ answers: 1, runs: 1, outbox: 1 })
  })

  it('validates empty/oversized input and forbids client-supplied identity or grading fields', async () => {
    for (const value of [
      { ...command(), answer: '   ' },
      { ...command(), answer: 'a'.repeat(8001) },
      { ...command(), userId: f.userId },
      { ...command(), passed: true },
      { ...command(), expectedTaskVersion: -1 },
      { ...command(), requestId: 'bad' },
    ]) {
      expect((await post(value)).status).toBe(400)
    }
    expect(await counts()).toEqual({ answers: 0, runs: 0, outbox: 0 })
  })

  it.each(['version', 'unbind', 'plan', 'passed', 'note-failed', 'source', 'busy'] as const)(
    'rejects %s without any write',
    async (change) => {
      if (change === 'version')
        await database.task.update({ where: { id: f.taskId }, data: { version: 7 } })
      if (change === 'unbind')
        await database.repository.update({
          where: { id: f.repositoryId },
          data: { enabled: false },
        })
      if (change === 'plan')
        await database.plan.update({ where: { id: f.planId }, data: { status: 'ARCHIVED' } })
      if (change === 'passed')
        await database.task.update({ where: { id: f.taskId }, data: { state: 'PASSED' } })
      if (change === 'note-failed')
        await database.agentRun.update({ where: { id: f.noteRunId }, data: { status: 'FAILED' } })
      if (change === 'source')
        await database.followUpQuestion.update({
          where: { id: f.questionId },
          data: { body: { ...f.body, source: { ...f.body.source, submissionId: randomUUID() } } },
        })
      if (change === 'busy')
        await database.agentRun.create({
          data: {
            taskId: f.taskId,
            kind: 'ANSWER_VERIFICATION',
            taskStateBeforeRun: 'NEEDS_EVIDENCE',
            workflowVersion: 'answer-v1',
            expectedTaskVersion: 6,
          },
        })
      expect((await post(command())).status).toBe(409)
      expect((await counts()).answers).toBe(0)
      expect((await counts()).outbox).toBe(0)
    },
  )

  it.each([false, true])(
    'rejects an old question after a newer note exists, even if its Run failed: %s',
    async (withFailedRun) => {
      const newer = await database.submission.create({
        data: {
          taskId: f.taskId,
          repositoryId: f.repositoryId,
          taskVersion: 7,
          beforeCommitSha: 'b'.repeat(40),
          afterCommitSha: 'c'.repeat(40),
          targetPath: 'notes/event-loop.md',
          workflowVersion: 'note-v1',
        },
      })
      await database.task.update({
        where: { id: f.taskId },
        data: { version: 8, state: 'NEEDS_EVIDENCE' },
      })
      if (withFailedRun)
        await database.agentRun.create({
          data: {
            taskId: f.taskId,
            submissionId: newer.id,
            kind: 'NOTE_VERIFICATION',
            status: 'FAILED',
            expectedTaskVersion: 8,
            taskStateBeforeRun: 'NEEDS_EVIDENCE',
            workflowVersion: 'note-v1',
          },
        })
      expect((await post({ ...command(), expectedTaskVersion: 8 })).status).toBe(409)
      expect(await counts()).toEqual({ answers: 0, runs: 0, outbox: 0 })
    },
  )

  it('rolls back the answer, Run and Task version when outbox persistence fails, then accepts the same request', async () => {
    const input = command()
    rejectOutbox = true
    const response = await post(input)
    expect(response.status).toBe(500)
    expect(JSON.stringify(await response.json())).not.toContain('fixture-private-outbox-error')
    expect(await counts()).toEqual({ answers: 0, runs: 0, outbox: 0 })
    expect(await database.task.findUnique({ where: { id: f.taskId } })).toMatchObject({
      state: 'VERIFYING',
      version: 6,
    })
    rejectOutbox = false
    await accepted(input)
    expect(await counts()).toEqual({ answers: 1, runs: 1, outbox: 1 })
  })
})
