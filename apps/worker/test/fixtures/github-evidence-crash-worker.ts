import {
  githubEvidenceJobPayloadSchema,
  type GitHubEvidenceJobPayload,
} from '@knowledgeops/contracts'
import { createDatabaseClient, type DatabaseClient } from '@knowledgeops/database'
import { Worker } from 'bullmq'
import { GitHubEvidenceJobProcessor } from '../../src/github/github-evidence-job-processor.js'
import type { ReadBoundCommitEvidenceResult } from '../../src/github/read-bound-commit-evidence.js'
import { createGitHubEvidenceBullMqProcessor } from '../../src/queue/bullmq-github-evidence-queue.js'
import { bullMqWorkerConnection } from '../../src/queue/bullmq-connections.js'

// 只由集成测试作为子进程启动；使用合成读取结果，不加载 GitHub/模型配置或启动 Dispatcher。
interface CrashFixture {
  queueName: string
  payload: GitHubEvidenceJobPayload
  collected: ReadBoundCommitEvidenceResult
  checkpoint?: 'before-commit' | 'after-commit'
}

function fatal() {
  process.send?.({ event: 'fixture-failed' }, () => process.exit(1))
  if (!process.connected) process.exit(1)
}

async function run(fixture: CrashFixture) {
  if (!/^r06-evidence-test-[0-9a-f-]{36}$/.test(fixture.queueName))
    throw new Error('Expected isolated test queue')
  const databaseUrl = process.env.DATABASE_URL!
  const redisUrl = process.env.REDIS_URL!
  for (const url of [databaseUrl, redisUrl]) {
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
      throw new Error('Expected local test infrastructure')
  }
  const expected = githubEvidenceJobPayloadSchema.parse(fixture.payload)
  const database = createDatabaseClient(databaseUrl)
  const transactional =
    fixture.checkpoint === 'before-commit'
      ? (database.$extends({
          query: {
            outboxEvent: {
              async create({ args, query }) {
                const result = await query(args)
                if (args.data.type === 'NOTE_VERIFICATION_REQUESTED') {
                  // 真实 SQL 已执行，外层事务尚未提交；父进程在此处结束本进程。
                  process.send?.({ event: 'uncommitted-handoff' })
                  await new Promise<never>(() => {})
                }
                return result
              },
            },
          },
        }) as DatabaseClient)
      : database
  const processor = new GitHubEvidenceJobProcessor(transactional, {
    read: async () => fixture.collected,
  })
  const worker = new Worker(
    fixture.queueName,
    createGitHubEvidenceBullMqProcessor({
      process: async (payload, attempt) => {
        if (
          payload.eventId !== expected.eventId ||
          payload.deliveryId !== expected.deliveryId ||
          payload.retryEventId !== undefined
        )
          throw new Error('Unexpected fixture job')
        await processor.process(payload, attempt)
        // 事务已提交，但尚未向 BullMQ 返回。父测试在此时强制结束本进程。
        process.send?.({ event: 'committed-before-ack' })
        return new Promise<never>(() => {})
      },
    }),
    {
      connection: bullMqWorkerConnection(redisUrl),
      concurrency: 1,
      // 仅缩短隔离测试的锁和扫描时间；产品 Worker 保持原默认配置。
      lockDuration: 1_500,
      stalledInterval: 100,
      maxStalledCount: 1,
    },
  )
  worker.on('error', fatal)
  worker.on('failed', fatal)
  await worker.waitUntilReady()
}

if (!process.send) throw new Error('Run through the R06 integration test')
// 父测试被中止时也不能留下独立 Worker；不做优雅关闭以保留真实退出窗口。
process.on('disconnect', () => process.exit(1))
process.once('message', (message: CrashFixture) => {
  void run(message).catch(fatal)
})
