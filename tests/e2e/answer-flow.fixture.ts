import { test as base, expect } from '@playwright/test'
import { createDatabaseClient, type DatabaseClient } from '../../packages/database/dist/index.js'
import { hashToken, opaqueToken } from '../../apps/api/src/identity/auth-http.js'
import {
  createNoteVerificationFixture,
  type NoteFixtureIdentity,
} from '../../apps/worker/test/fixtures/verification.js'
import {
  answerWorkerEnvironment,
  createAnswerWorker,
  prepareFollowUp,
} from '../../apps/worker/test/fixtures/e2e-answer-worker.js'
import { cleanupFixture } from './cleanup-fixture.js'
import { databaseUrl, redisUrl, webOrigin } from './environment.js'

type AnswerFlow = {
  taskId: string
  noteRunId: string
  questionId: string
  nextTaskId: string
  database: DatabaseClient
  worker: ReturnType<typeof createAnswerWorker>
  releaseAnswerResult: () => void
}

export const test = base.extend<{ answerFlow: AnswerFlow; holdAnswerResult: boolean }>({
  holdAnswerResult: [false, { option: true }],
  answerFlow: async ({ context, holdAnswerResult }, use) => {
    const database = createDatabaseClient(databaseUrl)
    const environment = answerWorkerEnvironment(databaseUrl, redisUrl)
    let identity: NoteFixtureIdentity | undefined
    let worker: ReturnType<typeof createAnswerWorker> | undefined
    const token = opaqueToken()
    let releaseAnswerResult!: () => void
    const answerResultGate = new Promise<void>((resolve) => {
      releaseAnswerResult = resolve
    })
    if (!holdAnswerResult) releaseAnswerResult()
    try {
      const fixture = await database.$transaction(async (tx) => {
        const f = await createNoteVerificationFixture(tx as unknown as DatabaseClient, (value) => {
          identity = value
        })
        // 笔记准备直接走 Processor；浏览器回答产生的 Outbox 才由真实轮询领取。
        await tx.outboxEvent.delete({ where: { id: f.eventId } })
        const task = await tx.task.findUniqueOrThrow({ where: { id: f.taskId } })
        const next = await tx.task.create({
          data: {
            stageId: task.stageId,
            title: '下一步：事件循环练习',
            description: '在前置任务通过后开始',
            position: 1,
            estimatedMinutes: 15,
            state: 'BLOCKED',
            targetPath: 'notes/next.md',
            prerequisites: { create: { prerequisiteTaskId: task.id } },
          },
        })
        await tx.user.update({
          where: { id: f.userId },
          data: { githubLogin: 'r16-browser-fixture' },
        })
        await tx.session.create({
          data: {
            userId: f.userId,
            tokenHash: hashToken(token),
            expiresAt: new Date(Date.now() + 10 * 60_000),
          },
        })
        return { ...f, nextTaskId: next.id }
      })
      const question = await prepareFollowUp(database, environment, fixture.payload)
      worker = createAnswerWorker(database, environment, () => answerResultGate)
      await worker.start()
      await context.addCookies([
        {
          name: 'knowledgeops_session',
          value: token,
          url: webOrigin,
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
        },
      ])
      await use({
        taskId: fixture.taskId,
        noteRunId: fixture.runId,
        questionId: question.id,
        nextTaskId: fixture.nextTaskId,
        database,
        worker,
        releaseAnswerResult,
      })
    } finally {
      // 即使中途断言失败，也先放行模型，避免关闭 Worker 时一直等待。
      releaseAnswerResult()
      // 先停止投递并等待正在消费的任务，再删本次数据；不触碰其他队列或用户。
      try {
        await worker?.close()
      } finally {
        try {
          if (identity) await cleanupFixture(database, identity)
        } finally {
          await database.$disconnect()
        }
      }
    }
  },
})
export { expect }
