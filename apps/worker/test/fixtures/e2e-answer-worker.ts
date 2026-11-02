import { randomUUID } from 'node:crypto'
import type { DatabaseClient } from '@knowledgeops/database'
import { buildAnswerVerificationJobId } from '@knowledgeops/contracts'
import { Queue } from 'bullmq'
import { readWorkerEnvironment } from '../../src/config/environment.js'
import { NoteVerificationRunRepository } from '../../src/verification/note-verification-run.repository.js'
import {
  NoteVerificationExecutionRepository,
  VerificationExecutionRepository,
} from '../../src/verification/note-verification-execution.repository.js'
import { NoteVerificationJobProcessor } from '../../src/verification/note-verification-job-processor.js'
import { AnswerVerificationRunRepository } from '../../src/verification/answer-verification-run.repository.js'
import { AnswerVerificationJobProcessor } from '../../src/verification/answer-verification-job-processor.js'
import { answerExecutionResultSchema } from '../../src/verification/execute-persisted-answer-verification.js'
import { BullMqAnswerVerificationQueue } from '../../src/queue/bullmq-answer-verification-queue.js'
import { bullMqWorkerConnection } from '../../src/queue/bullmq-connections.js'
import { OutboxDispatcher } from '../../src/outbox/outbox-dispatcher.js'
import { OutboxDispatchLoop } from '../../src/outbox/outbox-dispatch-loop.js'

const usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 }
export const answerRationale = '合成验收结果：回答说明了先清空微任务，再执行下一宏任务。'

// 显式测试配置，不读取真实模型密钥。单价、用量均为合成账本数据。
export function answerWorkerEnvironment(databaseUrl: string, redisUrl: string) {
  return readWorkerEnvironment({
    NODE_ENV: 'test',
    OPENAI_API_KEY: 'r16-unused-synthetic-port',
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    NOTE_VERIFICATION_MODEL_JSON: JSON.stringify({
      catalogId: 'r16-fixture',
      modelName: 'r16-fixture',
      currency: 'CNY',
      inputMicrounitsPerMillionTokens: 8_000_000,
      outputMicrounitsPerMillionTokens: 28_000_000,
    }),
  })
}
type Environment = ReturnType<typeof answerWorkerEnvironment>

// 两种浏览器装配共用真实 Processor，只替换外部模型输出。
export function createNoteProcessor(database: DatabaseClient, environment: Environment) {
  return new NoteVerificationJobProcessor(
    new NoteVerificationRunRepository(database, environment),
    new NoteVerificationExecutionRepository(database),
    {
      verify: async (request) => ({
        usage,
        candidate: {
          results: request.criteria.map((criterion) => ({
            criterionId: criterion.id,
            outcome: 'PASSED',
            rationale: 'R16 合成笔记验收：通过',
            suggestions: [],
            confidence: 0.8,
            citations: [{ startLine: 3, endLine: 3, excerpt: request.note.lines[2]! }],
          })),
        },
      }),
    },
    {
      generate: async (request) => ({
        usage,
        candidate: {
          question: '微任务又加入微任务时，为什么仍先于下一宏任务？',
          rubric: ['说明微任务队列会清空。'],
          citations: [{ startLine: 3, endLine: 3, excerpt: request.note.lines[2]! }],
        },
      }),
    },
  )
}

// 旧回答用例直接准备笔记结果；完整链路用例将同一 Processor 接入队列。
export async function prepareFollowUp(
  database: DatabaseClient,
  environment: Environment,
  payload: { runId: string; submissionId: string },
) {
  const processor = createNoteProcessor(database, environment)
  const result = await processor.process(payload)
  if (result.status !== 'SUCCEEDED' || !result.reportId) throw new Error('R16 note setup failed')
  return database.followUpQuestion.findUniqueOrThrow({ where: { reportId: result.reportId } })
}

export function createAnswerProcessor(
  database: DatabaseClient,
  environment: Environment,
  onModelCall: () => void | Promise<void>,
) {
  return new AnswerVerificationJobProcessor(
    new AnswerVerificationRunRepository(database, environment),
    new VerificationExecutionRepository(
      database,
      'ANSWER_VERIFICATION',
      answerExecutionResultSchema,
    ),
    {
      verify: async (request) => {
        await onModelCall()
        return {
          usage,
          candidate: {
            outcome: 'PASSED',
            rationale: answerRationale,
            suggestions: [],
            confidence: 0.8,
            citations: [{ startLine: 3, endLine: 3, excerpt: request.note.lines[2]! }],
            answerCitations: [{ startLine: 1, endLine: 1, excerpt: request.answer.content }],
          },
        }
      },
    },
  )
}

// 浏览器提交后，由生产中的 Dispatcher/Queue/Processor/账本/Finalizer 接力。
// 消费运行在测试进程，不启动另一份 Nest Runtime。
export function createAnswerWorker(
  database: DatabaseClient,
  environment: Environment,
  beforeModelResult?: () => Promise<void>,
) {
  let modelCalls = 0
  const processor = createAnswerProcessor(database, environment, async () => {
    modelCalls += 1
    // 仅在测试模型端口等待，保证浏览器先离线，再由真实 Finalizer 发布结果。
    await beforeModelResult?.()
  })
  const queueName = `r16-answer-${randomUUID()}`
  const queue = new BullMqAnswerVerificationQueue({
    redisUrl: environment.REDIS_URL,
    queueName,
    concurrency: 1,
    jobOptions: { attempts: 2, backoffDelayMs: 100 },
    processor,
  })
  const inspector = new Queue(queueName, {
    connection: bullMqWorkerConnection(environment.REDIS_URL),
  })
  const loop = new OutboxDispatchLoop(
    new OutboxDispatcher(
      database,
      {
        publish: async () => {
          throw new Error('Unexpected plan event in R16 answer fixture')
        },
        publishAnswerVerification: (message) => queue.publish(message),
      },
      { baseDelayMs: 100, maxDelayMs: 1000 },
    ),
    5,
    100,
  )
  return {
    async start() {
      queue.start()
      await queue.waitUntilReady()
      await loop.start()
    },
    get modelCalls() {
      return modelCalls
    },
    async jobState(runId: string) {
      return (await inspector.getJob(buildAnswerVerificationJobId(runId)))?.getState()
    },
    async close() {
      await loop.stop()
      try {
        await queue.close()
      } finally {
        try {
          await inspector.obliterate({ force: true })
        } finally {
          await inspector.close()
        }
      }
    },
  }
}
