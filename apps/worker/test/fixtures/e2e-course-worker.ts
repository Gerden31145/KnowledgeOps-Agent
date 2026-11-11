import { randomUUID } from 'node:crypto'
import type { DatabaseClient } from '@knowledgeops/database'
import { validPlanGenerationOutput } from '../../../../packages/agent-core/test/fixtures/plan-generation.js'
import { validCourseLearningPackage } from '../../../../packages/agent-core/test/fixtures/course-generation.js'
import { PlanGenerationJobProcessor } from '../../src/plan-generation/plan-generation-job-processor.js'
import { PlanGenerationRunRepository } from '../../src/plan-generation/plan-generation-run.repository.js'
import { FinalizePlanGenerationRun } from '../../src/plan-generation/finalize-plan-generation-run.js'
import { CourseGenerationJobProcessor } from '../../src/course-generation/course-generation-job-processor.js'
import { CourseGenerationRunRepository } from '../../src/course-generation/course-generation-run.repository.js'
import { FinalizeCourseGenerationRun } from '../../src/course-generation/finalize-course-generation-run.js'
import { BullMqPlanGenerationQueue } from '../../src/queue/bullmq-plan-generation-queue.js'
import { BullMqCourseGenerationQueue } from '../../src/queue/bullmq-course-generation-queue.js'
import { bullMqWorkerConnection } from '../../src/queue/bullmq-connections.js'
import { OutboxDispatcher } from '../../src/outbox/outbox-dispatcher.js'
import { OutboxDispatchLoop } from '../../src/outbox/outbox-dispatch-loop.js'
import { Queue } from 'bullmq'

export function createCoursePipelineWorker(database: DatabaseClient, redisUrl: string) {
  const prefix = `m7-course-${randomUUID()}`
  const common = { redisUrl, concurrency: 1, jobOptions: { attempts: 2, backoffDelayMs: 100 } }
  let courseModelCalls = 0
  const plan = new BullMqPlanGenerationQueue({
    ...common,
    queueName: `${prefix}-plan`,
    processor: new PlanGenerationJobProcessor(
      new PlanGenerationRunRepository(database),
      { generate: async () => validPlanGenerationOutput },
      new FinalizePlanGenerationRun(database),
    ),
  })
  const course = new BullMqCourseGenerationQueue({
    ...common,
    queueName: `${prefix}-course`,
    processor: new CourseGenerationJobProcessor(
      new CourseGenerationRunRepository(database),
      {
        generate: async () => {
          courseModelCalls += 1
          return validCourseLearningPackage
        },
      },
      new FinalizeCourseGenerationRun(database),
    ),
  })
  const queues = [plan, course]
  const inspectors = ['plan', 'course'].map(
    (kind) => new Queue(`${prefix}-${kind}`, { connection: bullMqWorkerConnection(redisUrl) }),
  )
  const loop = new OutboxDispatchLoop(
    new OutboxDispatcher(
      database,
      {
        publish: (message) => plan.publish(message),
        publishCourseGeneration: (message) => course.publish(message),
      },
      { baseDelayMs: 100, maxDelayMs: 1_000 },
    ),
    5,
    100,
  )
  return {
    get courseModelCalls() {
      return courseModelCalls
    },
    async start() {
      for (const queue of queues) queue.start()
      await Promise.all(queues.map((queue) => queue.waitUntilReady()))
      await loop.start()
    },
    async close() {
      await loop.stop()
      const workers = await Promise.allSettled(queues.map((queue) => queue.close()))
      const connections = await Promise.allSettled(
        inspectors.map(async (queue) => {
          try {
            await queue.obliterate({ force: true })
          } finally {
            await queue.close()
          }
        }),
      )
      const failure = [...workers, ...connections].find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    },
  }
}
