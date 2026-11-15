import { randomUUID } from 'node:crypto'
import { test as base, expect } from '@playwright/test'
import { createDatabaseClient } from '../../packages/database/dist/index.js'
import { hashToken, opaqueToken } from '../../apps/api/src/identity/auth-http.js'
import { createCoursePipelineWorker } from '../../apps/worker/test/fixtures/e2e-course-worker.js'
import { createCourseQuestionUpstream } from '../../apps/worker/test/fixtures/e2e-course-question-upstream.js'
import { databaseUrl, redisUrl, webOrigin } from './environment.js'

export const test = base.extend<{
  courseFlow: {
    userId: string
    database: ReturnType<typeof createDatabaseClient>
    worker: ReturnType<typeof createCoursePipelineWorker>
    questionUpstream: ReturnType<typeof createCourseQuestionUpstream>
  }
}>({
  courseFlow: async ({ context }, use) => {
    const database = createDatabaseClient(databaseUrl)
    const userId = randomUUID()
    const token = opaqueToken()
    const worker = createCoursePipelineWorker(database, redisUrl)
    const questionUpstream = createCourseQuestionUpstream()
    try {
      await database.user.create({
        data: {
          id: userId,
          githubLogin: 'm7-course-flow',
          sessions: {
            create: {
              tokenHash: hashToken(token),
              expiresAt: new Date(Date.now() + 10 * 60_000),
            },
          },
        },
      })
      await worker.start()
      await questionUpstream.start()
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
      await use({ userId, database, worker, questionUpstream })
    } finally {
      try {
        await worker.close()
        await questionUpstream.close()
        const planRuns = await database.planGenerationRun.findMany({
          where: { goal: { userId } },
          select: { id: true },
        })
        const courseRuns = await database.courseGenerationRun.findMany({
          where: { course: { task: { stage: { plan: { goal: { userId } } } } } },
          select: { id: true },
        })
        const questions = await database.courseQuestion.findMany({
          where: { userId },
          select: { id: true },
        })
        const exerciseSubmissions = await database.courseExerciseSubmission.findMany({
          where: { userId },
          select: { id: true },
        })
        await database.outboxEvent.deleteMany({
          where: {
            aggregateId: {
              in: [...planRuns, ...courseRuns, ...questions, ...exerciseSubmissions].map(
                (record) => record.id,
              ),
            },
          },
        })
        await database.user.delete({ where: { id: userId } })
      } finally {
        await database.$disconnect()
      }
    }
  },
})

export { expect }
