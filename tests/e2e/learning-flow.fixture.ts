import { randomInt, randomUUID } from 'node:crypto'
import { test as base, expect } from '@playwright/test'
import { createDatabaseClient, type DatabaseClient } from '../../packages/database/dist/index.js'
import { hashToken, opaqueToken } from '../../apps/api/src/identity/auth-http.js'
import { createPipelineWorker } from '../../apps/worker/test/fixtures/e2e-pipeline-worker.js'
import { repositoryName } from '../../apps/worker/test/fixtures/e2e-github-upstream.js'
import { databaseUrl, redisUrl, webOrigin } from './environment.js'

type LearningFlow = {
  userId: string
  installationId: string
  repositoryId: string
  deliveryId: string
  database: DatabaseClient
  worker: ReturnType<typeof createPipelineWorker>
}

export const test = base.extend<{ learningFlow: LearningFlow }>({
  learningFlow: async ({ context }, use) => {
    const database = createDatabaseClient(databaseUrl)
    const userId = randomUUID(),
      repositoryId = randomUUID(),
      deliveryId = randomUUID()
    const installationId = String(randomInt(8_000_000_000_000, 9_000_000_000_000))
    const token = opaqueToken()
    let worker: ReturnType<typeof createPipelineWorker> | undefined
    try {
      // 唯一预设：已登录且已绑定。Goal/Plan/Task/Delivery/报告均由后续真实请求产生。
      await database.$transaction(async (tx) => {
        await tx.user.create({
          data: {
            id: userId,
            githubLogin: 'r16-learning-flow',
            sessions: {
              create: {
                tokenHash: hashToken(token),
                expiresAt: new Date(Date.now() + 10 * 60_000),
              },
            },
          },
        })
        await tx.gitHubInstallation.create({
          data: {
            id: installationId,
            accountId: '42',
            accountLogin: 'r16-fixture',
            verifiedAt: new Date(),
          },
        })
        await tx.repository.create({
          data: {
            id: repositoryId,
            userId,
            installationId,
            githubRepositoryId: installationId,
            fullName: repositoryName,
            branch: 'main',
            defaultBranch: 'main',
            isPrivate: true,
          },
        })
      })
      worker = createPipelineWorker(database, databaseUrl, redisUrl, installationId)
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
      await use({ userId, installationId, repositoryId, deliveryId, database, worker })
    } finally {
      try {
        await worker?.close()
      } finally {
        try {
          await database.$transaction(async (tx) => {
            const taskWhere = { stage: { plan: { goal: { userId } } } }
            const runs = await tx.agentRun.findMany({
              where: { task: taskWhere },
              select: { id: true },
            })
            const generations = await tx.planGenerationRun.findMany({
              where: { goal: { userId } },
              select: { id: true },
            })
            await tx.outboxEvent.deleteMany({
              where: {
                aggregateId: {
                  in: [
                    deliveryId,
                    ...runs.map((run) => run.id),
                    ...generations.map((run) => run.id),
                  ],
                },
              },
            })
            // Delivery 和回答引用旧报告；按外键关系顺序删除本次用户的数据。
            await tx.webhookDelivery.deleteMany({ where: { id: deliveryId } })
            await tx.agentRun.deleteMany({
              where: { task: taskWhere, kind: 'ANSWER_VERIFICATION' },
            })
            await tx.answerSubmission.deleteMany({
              where: { question: { report: { run: { task: taskWhere } } } },
            })
            await tx.agentRun.deleteMany({ where: { task: taskWhere } })
            await tx.submission.deleteMany({ where: { task: taskWhere } })
            await tx.plan.deleteMany({ where: { goal: { userId } } })
            await tx.user.deleteMany({ where: { id: userId } })
            await tx.gitHubInstallation.deleteMany({ where: { id: installationId } })
          })
        } finally {
          await database.$disconnect()
        }
      }
    }
  },
})
export { expect }
