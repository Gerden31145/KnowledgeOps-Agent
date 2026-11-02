import { randomUUID } from 'node:crypto'
import type { BrowserContext } from '@playwright/test'
import type { DatabaseClient } from '../../packages/database/dist/index.js'
import {
  followUpAnswerAcceptedResponseSchema,
  retryAnswerVerificationResponseSchema,
  retryNoteVerificationResponseSchema,
} from '../../packages/contracts/dist/index.js'
import {
  answerWorkerEnvironment,
  prepareFollowUp,
} from '../../apps/worker/test/fixtures/e2e-answer-worker.js'
import { test, expect } from './two-users.fixture.js'
import { apiOrigin, databaseUrl, redisUrl, webOrigin } from './environment.js'

const post = (context: BrowserContext, path: string, data: unknown = {}) =>
  context.request.post(`${apiOrigin}${path}`, { headers: { origin: webOrigin }, data })

// 对照两名用户的实际业务记录，不能只断言 HTTP 404 而漏掉写入副作用。
async function snapshot(database: DatabaseClient, taskIds: string[]) {
  const tasks = await database.task.findMany({
    where: { id: { in: taskIds } },
    include: { stage: { include: { plan: true } } },
    orderBy: { id: 'asc' },
  })
  const runs = await database.agentRun.findMany({
    where: { taskId: { in: taskIds } },
    include: { report: true },
    orderBy: { id: 'asc' },
  })
  const answers = await database.answerSubmission.findMany({
    where: { question: { report: { run: { taskId: { in: taskIds } } } } },
    orderBy: { id: 'asc' },
  })
  const outbox = await database.outboxEvent.findMany({
    where: { aggregateId: { in: runs.map((run) => run.id) } },
    orderBy: { id: 'asc' },
  })
  return { tasks, runs, answers, outbox }
}

async function deniedLikeMissing(
  context: BrowserContext,
  path: string,
  missingPath: string,
  command: unknown = {},
) {
  const denied = await post(context, path, command)
  const missing = await post(context, missingPath, command)
  expect(denied.status(), path).toBe(404)
  expect(missing.status(), missingPath).toBe(404)
  expect(await denied.json()).toEqual(await missing.json())
}

// 复用已有真实笔记 Processor + 合成模型端口准备追问；本文件不启动队列消费者。
async function readyQuestion(database: DatabaseClient, user: { taskId: string; runId: string }) {
  const run = await database.$transaction(async (tx) => {
    await tx.verificationReport.deleteMany({ where: { runId: user.runId } })
    await tx.task.update({ where: { id: user.taskId }, data: { state: 'VERIFYING', version: 6 } })
    return tx.agentRun.update({
      where: { id: user.runId },
      data: { status: 'QUEUED', version: 0, startedAt: null, finishedAt: null },
    })
  })
  return prepareFollowUp(database, answerWorkerEnvironment(databaseUrl, redisUrl), {
    runId: run.id,
    submissionId: run.submissionId!,
  })
}

test('确认计划与开始任务：本人可写，跨用户首次请求与重复请求均不能写', async ({
  users: { a, b, database },
}) => {
  const taskIds = [a.taskId, b.taskId]
  await database.$transaction(async (tx) => {
    for (const user of [a, b]) {
      // 本段起点是尚未确认的计划，清除共用夹具中已存的笔记结果。
      await tx.agentRun.delete({ where: { id: user.runId } })
      await tx.submission.deleteMany({ where: { taskId: user.taskId } })
      await tx.plan.update({
        where: { id: user.planId },
        data: { status: 'DRAFT', confirmedAt: null },
      })
      await tx.task.update({ where: { id: user.taskId }, data: { state: 'BLOCKED', version: 0 } })
    }
  })
  for (const [owner, other] of [
    [a, b],
    [b, a],
  ] as const) {
    for (const operation of [
      {
        path: `/plans/${owner.planId}/confirm`,
        missing: `/plans/${randomUUID()}/confirm`,
        state: 'ACTIVE',
      },
      {
        path: `/tasks/${owner.taskId}/start`,
        missing: `/tasks/${randomUUID()}/start`,
        state: 'IN_PROGRESS',
      },
    ]) {
      const before = await snapshot(database, taskIds)
      await deniedLikeMissing(other.context, operation.path, operation.missing)
      expect(await snapshot(database, taskIds)).toEqual(before)
      const accepted = await post(owner.context, operation.path)
      expect(accepted.status()).toBe(201)
      const receipt = await accepted.json()
      if (operation.state === 'ACTIVE')
        expect(
          await database.plan.findUniqueOrThrow({ where: { id: owner.planId } }),
        ).toMatchObject({ status: 'ACTIVE' })
      else
        expect(
          await database.task.findUniqueOrThrow({ where: { id: owner.taskId } }),
        ).toMatchObject({ state: 'IN_PROGRESS', version: 2 })

      const saved = await snapshot(database, taskIds)
      await deniedLikeMissing(other.context, operation.path, operation.missing)
      const replay = await post(owner.context, operation.path)
      expect(replay.status()).toBe(201)
      expect(await replay.json()).toEqual(receipt)
      expect(await snapshot(database, taskIds)).toEqual(saved)
    }
  }
})

test('回答提交：知道他人的 questionId 与原 requestId 也不能创建回答或取走已有回执', async ({
  users: { a, b, database },
}) => {
  const taskIds = [a.taskId, b.taskId]
  for (const [owner, other] of [
    [a, b],
    [b, a],
  ] as const) {
    const question = await readyQuestion(database, owner)
    const path = `/follow-up-questions/${question.id}/answers`
    const missing = `/follow-up-questions/${randomUUID()}/answers`
    const command = {
      requestId: randomUUID(),
      expectedTaskVersion: 7,
      answer: '微任务队列清空后才执行下一宏任务。',
    }
    const before = await snapshot(database, taskIds)
    await deniedLikeMissing(other.context, path, missing, command)
    expect(await snapshot(database, taskIds)).toEqual(before)

    const accepted = await post(owner.context, path, command)
    expect(accepted.status()).toBe(202)
    const receipt = followUpAnswerAcceptedResponseSchema.parse(await accepted.json())
    expect(receipt).toMatchObject({ taskId: owner.taskId, taskVersion: 8 })
    expect(
      await database.answerSubmission.findUniqueOrThrow({
        where: { id: receipt.answerSubmissionId },
      }),
    ).toMatchObject({
      questionId: question.id,
      requestId: command.requestId,
      content: command.answer,
    })
    expect(await database.outboxEvent.count({ where: { aggregateId: receipt.runId } })).toBe(1)

    // 完全相同的命令已有结果，也必须先查请求者归属，再考虑幂等返回。
    const saved = await snapshot(database, taskIds)
    await deniedLikeMissing(other.context, path, missing, command)
    const replay = await post(owner.context, path, command)
    expect(replay.status()).toBe(202)
    expect(await replay.json()).toEqual(receipt)
    expect(await snapshot(database, taskIds)).toEqual(saved)
    expect(
      (
        await other.context.request.get(
          `${apiOrigin}/answer-submissions/${receipt.answerSubmissionId}`,
        )
      ).status(),
    ).toBe(404)
  }
})

test('笔记重试：已有后继 Run 时仍先检查所属用户，原回执只返回给本人', async ({
  users: { a, b, database },
}) => {
  const taskIds = [a.taskId, b.taskId]
  await database.$transaction(async (tx) => {
    for (const user of [a, b]) {
      await tx.verificationReport.deleteMany({ where: { runId: user.runId } })
      await tx.agentRun.update({
        where: { id: user.runId },
        data: { status: 'FAILED', version: 1, errorCode: 'MODEL_TIMEOUT' },
      })
      await tx.task.update({
        where: { id: user.taskId },
        data: { state: 'IN_PROGRESS', version: 7 },
      })
    }
  })
  for (const [owner, other] of [
    [a, b],
    [b, a],
  ] as const) {
    const path = `/agent-runs/${owner.runId}/retry`
    const missing = `/agent-runs/${randomUUID()}/retry`
    const command = { expectedRunVersion: 1, expectedTaskVersion: 7 }
    const before = await snapshot(database, taskIds)
    await deniedLikeMissing(other.context, path, missing, command)
    expect(await snapshot(database, taskIds)).toEqual(before)
    const accepted = await post(owner.context, path, command)
    expect(accepted.status()).toBe(202)
    const receipt = retryNoteVerificationResponseSchema.parse(await accepted.json())
    expect(receipt).toMatchObject({
      retryOfRunId: owner.runId,
      taskId: owner.taskId,
      taskVersion: 8,
    })
    expect(
      await database.agentRun.findUniqueOrThrow({ where: { id: receipt.runId } }),
    ).toMatchObject({ retryOfRunId: owner.runId, taskId: owner.taskId, status: 'QUEUED' })
    expect(await database.outboxEvent.count({ where: { aggregateId: receipt.runId } })).toBe(1)

    const saved = await snapshot(database, taskIds)
    await deniedLikeMissing(other.context, path, missing, command)
    const replay = await post(owner.context, path, command)
    expect(replay.status()).toBe(202)
    expect(await replay.json()).toEqual(receipt)
    expect(await snapshot(database, taskIds)).toEqual(saved)
  }
})

test('回答重试：回答与 Run 必须同时匹配当前用户，不能混搭 ID 或借用已有重试回执', async ({
  users: { a, b, database },
}) => {
  const taskIds = [a.taskId, b.taskId]
  const originals = []
  for (const owner of [a, b]) {
    const question = await readyQuestion(database, owner)
    const accepted = await post(owner.context, `/follow-up-questions/${question.id}/answers`, {
      requestId: randomUUID(),
      expectedTaskVersion: 7,
      answer: '微任务会在下一宏任务前执行。',
    })
    expect(accepted.status()).toBe(202)
    const receipt = followUpAnswerAcceptedResponseSchema.parse(await accepted.json())
    originals.push({ owner, receipt })
    // 合成失败终态作为重试起点，不启动消费者或真实模型。
    await database.agentRun.update({
      where: { id: receipt.runId },
      data: {
        status: 'FAILED',
        version: 1,
        finishedAt: new Date(),
        errorCode: 'MODEL_TIMEOUT',
      },
    })
    await database.task.update({
      where: { id: owner.taskId },
      data: { state: 'NEEDS_EVIDENCE', version: 9 },
    })
  }
  for (const { owner, receipt: original } of originals) {
    const other = originals.find((item) => item.owner.userId !== owner.userId)!
    const path = `/answer-submissions/${original.answerSubmissionId}/runs/${original.runId}/retry`
    const missing = `/answer-submissions/${randomUUID()}/runs/${randomUUID()}/retry`
    const command = { expectedRunVersion: 1, expectedTaskVersion: 9 }
    const before = await snapshot(database, taskIds)
    await deniedLikeMissing(other.owner.context, path, missing, command)
    // 一部分 ID 属于本人也不够，不能把自己的回答配上他人的 Run。
    await deniedLikeMissing(
      owner.context,
      `/answer-submissions/${original.answerSubmissionId}/runs/${other.receipt.runId}/retry`,
      missing,
      command,
    )
    await deniedLikeMissing(
      owner.context,
      `/answer-submissions/${other.receipt.answerSubmissionId}/runs/${original.runId}/retry`,
      missing,
      command,
    )
    expect(await snapshot(database, taskIds)).toEqual(before)

    const accepted = await post(owner.context, path, command)
    expect(accepted.status()).toBe(202)
    const receipt = retryAnswerVerificationResponseSchema.parse(await accepted.json())
    expect(receipt).toMatchObject({
      answerSubmissionId: original.answerSubmissionId,
      retryOfRunId: original.runId,
      taskId: owner.taskId,
      taskVersion: 10,
    })
    expect(
      await database.agentRun.findUniqueOrThrow({ where: { id: receipt.runId } }),
    ).toMatchObject({
      answerSubmissionId: original.answerSubmissionId,
      retryOfRunId: original.runId,
      status: 'QUEUED',
    })
    expect(await database.outboxEvent.count({ where: { aggregateId: receipt.runId } })).toBe(1)
    const saved = await snapshot(database, taskIds)
    await deniedLikeMissing(other.owner.context, path, missing, command)
    const replay = await post(owner.context, path, command)
    expect(replay.status()).toBe(202)
    expect(await replay.json()).toEqual(receipt)
    expect(await snapshot(database, taskIds)).toEqual(saved)
  }
})
