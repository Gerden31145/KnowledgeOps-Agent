import { randomUUID } from 'node:crypto'
import type { DatabaseClient } from '@knowledgeops/database'
import {
  buildPlanGenerationJobId,
  buildGitHubEvidenceJobId,
  buildNoteVerificationJobId,
  buildAnswerVerificationJobId,
} from '@knowledgeops/contracts'
import { Queue } from 'bullmq'
import { PlanGenerationJobProcessor } from '../../src/plan-generation/plan-generation-job-processor.js'
import { PlanGenerationRunRepository } from '../../src/plan-generation/plan-generation-run.repository.js'
import { FinalizePlanGenerationRun } from '../../src/plan-generation/finalize-plan-generation-run.js'
import { GitHubEvidenceJobProcessor } from '../../src/github/github-evidence-job-processor.js'
import { BullMqPlanGenerationQueue } from '../../src/queue/bullmq-plan-generation-queue.js'
import { BullMqGitHubEvidenceQueue } from '../../src/queue/bullmq-github-evidence-queue.js'
import { BullMqNoteVerificationQueue } from '../../src/queue/bullmq-note-verification-queue.js'
import { BullMqAnswerVerificationQueue } from '../../src/queue/bullmq-answer-verification-queue.js'
import { bullMqWorkerConnection } from '../../src/queue/bullmq-connections.js'
import { OutboxDispatcher } from '../../src/outbox/outbox-dispatcher.js'
import { OutboxDispatchLoop } from '../../src/outbox/outbox-dispatch-loop.js'
import {
  answerWorkerEnvironment,
  createNoteProcessor,
  createAnswerProcessor,
} from './e2e-answer-worker.js'
import { createGitHubUpstream, pipelinePlan } from './e2e-github-upstream.js'

// 与生产共用消费者和投递实现；随机队列名只隔离本次浏览器测试的数据。
export function createPipelineWorker(
  database: DatabaseClient,
  databaseUrl: string,
  redisUrl: string,
  installationId: string,
) {
  const environment = answerWorkerEnvironment(databaseUrl, redisUrl)
  const github = createGitHubUpstream(database, installationId)
  const prefix = `r16-pipeline-${randomUUID()}`
  const common = { redisUrl, concurrency: 1, jobOptions: { attempts: 2, backoffDelayMs: 100 } }
  let answerModelCalls = 0
  const plan = new BullMqPlanGenerationQueue({
    ...common,
    queueName: `${prefix}-plan`,
    processor: new PlanGenerationJobProcessor(
      new PlanGenerationRunRepository(database),
      { generate: async () => pipelinePlan },
      new FinalizePlanGenerationRun(database),
    ),
  })
  const evidence = new BullMqGitHubEvidenceQueue({
    ...common,
    queueName: `${prefix}-evidence`,
    processor: new GitHubEvidenceJobProcessor(database, github.reader),
  })
  const note = new BullMqNoteVerificationQueue({
    ...common,
    queueName: `${prefix}-note`,
    processor: createNoteProcessor(database, environment),
  })
  const answer = new BullMqAnswerVerificationQueue({
    ...common,
    queueName: `${prefix}-answer`,
    processor: createAnswerProcessor(database, environment, () => {
      answerModelCalls += 1
    }),
  })
  const queues = [plan, evidence, note, answer]
  const inspectors = ['plan', 'evidence', 'note', 'answer'].map(
    (kind) =>
      new Queue(`${prefix}-${kind}`, {
        connection: bullMqWorkerConnection(redisUrl),
      }),
  )
  const loop = new OutboxDispatchLoop(
    new OutboxDispatcher(
      database,
      {
        publish: (message) => plan.publish(message),
        publishGitHubPush: (message) => evidence.publish(message),
        publishNoteVerification: (message) => note.publish(message),
        publishAnswerVerification: (message) => answer.publish(message),
      },
      { baseDelayMs: 100, maxDelayMs: 1000 },
    ),
    5,
    100,
  )
  return {
    githubCalls: github.calls,
    get answerModelCalls() {
      return answerModelCalls
    },
    async start() {
      for (const queue of queues) queue.start()
      await Promise.all(queues.map((queue) => queue.waitUntilReady()))
      await loop.start()
    },
    async jobStates(ids: {
      generationRunId: string
      deliveryId: string
      noteRunId: string
      answerRunId: string
    }) {
      const jobIds = [
        buildPlanGenerationJobId(ids.generationRunId),
        buildGitHubEvidenceJobId(ids.deliveryId),
        buildNoteVerificationJobId(ids.noteRunId),
        buildAnswerVerificationJobId(ids.answerRunId),
      ]
      return Promise.all(
        inspectors.map(async (queue, index) => (await queue.getJob(jobIds[index]!))?.getState()),
      )
    },
    async close() {
      // 先等所有消费者结束，再删除它们独占的队列；失败也尝试关闭其他连接。
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
