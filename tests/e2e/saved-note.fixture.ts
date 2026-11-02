import { test as base, expect } from '@playwright/test'
import { createDatabaseClient, type DatabaseClient } from '../../packages/database/dist/index.js'
import { noteVerificationReportBodySchema } from '../../packages/contracts/dist/index.js'
import { hashToken, opaqueToken } from '../../apps/api/src/identity/auth-http.js'
import {
  createNoteVerificationFixture,
  type NoteFixtureIdentity,
} from '../../apps/worker/test/fixtures/verification.js'
import { databaseUrl, webOrigin } from './environment.js'
import { cleanupFixture } from './cleanup-fixture.js'

// 首段刷新用例与双用户用例共用同一套真实持久化数据；label 用来区分私有内容。
export async function createSavedNote(
  database: DatabaseClient,
  register: (identity: NoteFixtureIdentity) => void,
  label = 'R16 合成结果',
) {
  const token = opaqueToken()
  const rationale = `还需要补充微任务与下一轮任务的顺序对比。（${label}）`
  const taskTitle = `${label}：事件循环`
  return database.$transaction(async (tx) => {
    const f = await createNoteVerificationFixture(tx as unknown as DatabaseClient, register)
    // 提交时只有终态 Run，没有可被 Worker 领取的 Outbox。
    await tx.outboxEvent.delete({ where: { id: f.eventId } })
    await tx.user.update({ where: { id: f.userId }, data: { githubLogin: 'r16-browser-fixture' } })
    await tx.session.create({
      data: {
        userId: f.userId,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    })
    const task = await tx.task.update({
      where: { id: f.taskId },
      data: { title: taskTitle, state: 'NEEDS_REVISION', version: 7 },
      include: { stage: true },
    })
    await tx.agentRun.update({
      where: { id: f.runId },
      data: { status: 'SUCCEEDED', version: 2, startedAt: new Date(), finishedAt: new Date() },
    })
    const criteria = await tx.acceptanceCriterion.findMany({ where: { taskId: f.taskId } })
    const report = await tx.verificationReport.create({
      data: {
        runId: f.runId,
        body: noteVerificationReportBodySchema.parse({
          results: criteria
            .filter((c) => c.type !== 'FOLLOW_UP_ANSWER')
            .map((c) => ({
              criterionId: c.id,
              outcome: c.type === 'SEMANTIC_CORRECTNESS' ? 'FAILED' : 'PASSED',
              rationale: c.type === 'SEMANTIC_CORRECTNESS' ? rationale : '合成检查结果：通过',
              suggestions: [],
              citations: [],
              confidence: 1,
            })),
          exemptions: [],
          pendingCriterionIds: criteria
            .filter((c) => c.type === 'FOLLOW_UP_ANSWER')
            .map((c) => c.id),
          accounting: {
            knownTotalTokens: 0,
            knownCostMicrounits: 0,
            currency: 'CNY',
            usageComplete: true,
            warnings: [],
          },
        }),
      },
    })
    return {
      taskId: f.taskId,
      runId: f.runId,
      reportId: report.id,
      rationale,
      taskTitle,
      userId: f.userId,
      planId: task.stage.planId,
      repositoryId: f.repositoryId,
      token,
    }
  })
}

type SavedNote = Awaited<ReturnType<typeof createSavedNote>>

export const test = base.extend<{ savedNote: SavedNote }>({
  savedNote: async ({ context }, use) => {
    const database = createDatabaseClient(databaseUrl)
    let identity: NoteFixtureIdentity | undefined
    try {
      const savedNote = await createSavedNote(database, (value) => {
        identity = value
      })
      // 会话仍经正式 AuthGuard/数据库验证；本段不测试 GitHub OAuth 交换。
      await context.addCookies([
        {
          name: 'knowledgeops_session',
          value: savedNote.token,
          url: webOrigin,
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
        },
      ])
      await use(savedNote)
    } finally {
      try {
        if (identity) await cleanupFixture(database, identity)
      } finally {
        await database.$disconnect()
      }
    }
  },
})

export { expect }
