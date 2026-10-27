import assert from 'node:assert/strict'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { LangChainNoteVerifier, type NoteVerificationPort } from '@knowledgeops/agent-core'
import { buildNoteVerificationJobId } from '@knowledgeops/contracts'
import { createDatabaseClient } from '@knowledgeops/database'
import { Queue, QueueEvents } from 'bullmq'
import { NoteVerificationQueryService } from '../../api/src/verification/note-verification-query.service.js'
import { readWorkerEnvironment } from '../src/config/environment.js'
import { OutboxDispatcher } from '../src/outbox/outbox-dispatcher.js'
import {
  bullMqProducerConnection,
  bullMqWorkerConnection,
} from '../src/queue/bullmq-connections.js'
import { BullMqNoteVerificationQueue } from '../src/queue/bullmq-note-verification-queue.js'
import { NoteVerificationExecutionRepository } from '../src/verification/note-verification-execution.repository.js'
import { NoteVerificationJobProcessor } from '../src/verification/note-verification-job-processor.js'
import { NoteVerificationRunRepository } from '../src/verification/note-verification-run.repository.js'

// 手动付费 smoke，不属于自动测试。默认只读上次观察文件；--run 才发起真实验收。
// 只创建合成材料、随机用户与隔离队列；不启动全局 Dispatcher，不认领历史待办。
const outputDirectory = new URL('../.local/', import.meta.url)
const outputFile = new URL('r09-live-note-result.json', outputDirectory)
const args = process.argv.slice(2)
if (args.length === 0) {
  try {
    console.log(await readFile(outputFile, 'utf8'))
  } catch {
    console.log('尚无观察文件。显式追加 --run 才会调用真实模型并产生费用。')
    process.exitCode = 1
  }
} else if (args.length === 1 && args[0] === '--run') {
  await run().catch((error: unknown) => {
    // 不输出 SDK/数据库错误正文，防止连接信息或凭据进入终端记录。
    console.error(
      JSON.stringify({
        event: 'live-smoke-failed',
        errorType: error instanceof Error ? error.name : 'UnknownError',
        note: '检查上面的安全业务状态及本地观察文件；不会自动开启另一次付费运行。',
      }),
    )
    process.exitCode = 1
  })
} else {
  console.error('Usage: pnpm verify:r09:live [--run]')
  process.exitCode = 1
}

async function run() {
  const environment = readWorkerEnvironment({
    ...process.env,
    NOTE_VERIFICATION_MODEL_JSON: JSON.stringify({
      catalogId: 'glm-5-3',
      modelName: 'glm-5.3',
      currency: 'CNY',
      inputMicrounitsPerMillionTokens: 8_000_000,
      outputMicrounitsPerMillionTokens: 28_000_000,
    }),
    NOTE_VERIFICATION_TIMEOUT_MS: '180000',
    NOTE_VERIFICATION_MAX_TOTAL_TOKENS: '16000',
    NOTE_VERIFICATION_MAX_OUTPUT_TOKENS: '4096',
    NOTE_VERIFICATION_MAX_COST_MICROUNITS: '1000000',
  })
  for (const connection of [environment.DATABASE_URL, environment.REDIS_URL])
    assert(
      ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(connection).hostname),
      'LOCAL_INFRASTRUCTURE_ONLY',
    )
  assert(environment.OPENAI_API_KEY && environment.OPENAI_BASE_URL, 'MODEL_CONFIGURATION_REQUIRED')
  const endpoint = new URL(environment.OPENAI_BASE_URL)
  assert(
    endpoint.protocol === 'https:' &&
      endpoint.hostname === 'open.bigmodel.cn' &&
      !endpoint.username &&
      !endpoint.password &&
      !endpoint.search,
    'EXPECTED_GLM_ENDPOINT',
  )

  const database = createDatabaseClient(environment.DATABASE_URL)
  const id = {
    user: randomUUID(),
    task: randomUUID(),
    repository: randomUUID(),
    submission: randomUUID(),
    run: randomUUID(),
    event: randomUUID(),
    installation: String(randomInt(8_000_000_000_000, 9_000_000_000_000)),
  }
  const queueName = `r09-live-${id.run}`
  const queue = new Queue(queueName, {
    connection: bullMqProducerConnection(environment.REDIS_URL),
  })
  const events = new QueueEvents(queueName, {
    // QueueEvents 长轮询事件流，不能套用生产者的 2 秒命令超时。
    connection: bullMqWorkerConnection(environment.REDIS_URL),
  })
  const model = new LangChainNoteVerifier({
    apiKey: environment.OPENAI_API_KEY,
    baseUrl: environment.OPENAI_BASE_URL,
    structuredOutputMethod: environment.PLAN_GENERATION_OUTPUT_METHOD,
  })
  let modelCalls = 0
  const port: NoteVerificationPort = {
    verify: async (request, options) => {
      modelCalls++
      assert(modelCalls <= 2, 'SMOKE_CALL_LIMIT')
      console.log(
        JSON.stringify({
          event: 'model-request',
          model: request.model.modelName,
          attempt: modelCalls,
          semanticCriteria: request.criteria.length,
          maxOutputTokens: options.maxOutputTokens,
        }),
      )
      return model.verify(request, options)
    },
  }
  const processor = new NoteVerificationJobProcessor(
    new NoteVerificationRunRepository(database, environment),
    new NoteVerificationExecutionRepository(database),
    port,
  )
  const consumer = new BullMqNoteVerificationQueue({
    queueName,
    redisUrl: environment.REDIS_URL,
    concurrency: 1,
    jobOptions: { attempts: 1, backoffDelayMs: 1000 },
    processor,
  })
  const payload = { runId: id.run, submissionId: id.submission }
  const lines = [
    '# 事件循环',
    '',
    '## 执行顺序',
    '当前同步任务运行完成后，浏览器在微任务检查点清空微任务队列，然后才有机会执行下一个任务。',
    'Promise.then 的回调进入微任务队列；setTimeout 的回调属于后续任务，延迟为 0 也不会打断当前同步代码。',
    '',
    '例如依次执行 console.log("A")、Promise.resolve().then(() => console.log("B"))、setTimeout(() => console.log("C"), 0)、console.log("D")，输出顺序是 A、D、B、C。',
  ]
  const content = lines.join('\n')
  // 将普通轮询可见时间放到未来；本 smoke 只按自己 UUID 投递，使用独立的读取时钟。
  const availableAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
  let seeded = false
  try {
    await Promise.all([queue.waitUntilReady(), events.waitUntilReady(), consumer.waitUntilReady()])
    await database.$transaction(async (tx) => {
      await tx.user.create({
        data: {
          id: id.user,
          goals: {
            create: {
              title: 'R09 live smoke synthetic goal',
              currentLevel: '合成观察材料',
              weeklyMinutes: 120,
              deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
              plans: {
                create: {
                  status: 'ACTIVE',
                  stages: {
                    create: {
                      title: 'R09 smoke',
                      position: 0,
                      tasks: {
                        create: {
                          id: id.task,
                          title: '解释浏览器任务与微任务',
                          description:
                            '解释 Promise.then 和 setTimeout 的顺序，并用一个输出顺序例子说明。',
                          position: 0,
                          estimatedMinutes: 30,
                          state: 'VERIFYING',
                          version: 6,
                          targetPath: 'notes/event-loop.md',
                          criteria: {
                            create: [
                              {
                                type: 'FILE_CHANGED',
                                description: '修改任务目标文件',
                                position: 0,
                              },
                              {
                                type: 'SECTION_PRESENT',
                                description: '包含执行顺序章节',
                                position: 1,
                                config: { heading: '执行顺序' },
                              },
                              {
                                type: 'SEMANTIC_CORRECTNESS',
                                description:
                                  '正确解释同步任务、Promise 微任务、定时器任务的先后顺序，并正确解释示例输出。',
                                position: 2,
                              },
                              {
                                type: 'FOLLOW_UP_ANSWER',
                                description: '完成后续追问回答',
                                position: 3,
                              },
                            ],
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
      await tx.gitHubInstallation.create({
        data: {
          id: id.installation,
          accountId: '42',
          accountLogin: 'r09-synthetic',
          verifiedAt: new Date(),
        },
      })
      await tx.repository.create({
        data: {
          id: id.repository,
          userId: id.user,
          installationId: id.installation,
          githubRepositoryId: id.installation,
          fullName: 'r09-synthetic/notes',
          branch: 'main',
          defaultBranch: 'main',
          isPrivate: true,
        },
      })
      await tx.submission.create({
        data: {
          id: id.submission,
          repositoryId: id.repository,
          taskId: id.task,
          taskVersion: 5,
          beforeCommitSha: 'a'.repeat(40),
          afterCommitSha: 'b'.repeat(40),
          targetPath: 'notes/event-loop.md',
          workflowVersion: 'note-v1',
          evidence: {
            create: {
              content,
              contentHash: createHash('sha256').update(content).digest('hex'),
              lineCount: lines.length,
              sourceCommitSha: 'b'.repeat(40),
              mode: 'DIFF',
              change: 'modified',
              diff: `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}`,
            },
          },
        },
      })
      await tx.agentRun.create({
        data: {
          id: id.run,
          taskId: id.task,
          submissionId: id.submission,
          expectedTaskVersion: 6,
          kind: 'NOTE_VERIFICATION',
          taskStateBeforeRun: 'IN_PROGRESS',
          workflowVersion: 'note-v1',
        },
      })
      await tx.outboxEvent.create({
        data: {
          id: id.event,
          type: 'NOTE_VERIFICATION_REQUESTED',
          aggregateId: id.run,
          deduplicationKey: `note-verification-requested-${id.run}`,
          payload,
          availableAt,
        },
      })
    })
    seeded = true
    console.log(
      JSON.stringify({
        event: 'live-smoke-started',
        runId: id.run,
        model: 'glm-5.3',
        syntheticEvidence: true,
        queueName,
        timeoutMs: 180000,
        maxModelCalls: 2,
      }),
    )
    const dispatcher = new OutboxDispatcher(
      database,
      {
        publish: async () => {
          throw new Error('UNEXPECTED_PLAN_JOB')
        },
        publishNoteVerification: (message) => consumer.publish(message),
      },
      { baseDelayMs: 100, maxDelayMs: 1000 },
      () => availableAt,
    )
    assert.equal((await dispatcher.dispatchEvent(id.event)).status, 'DISPATCHED')
    const job = await queue.getJob(buildNoteVerificationJobId(id.run))
    assert(job)
    consumer.start()
    await job.waitUntilFinished(events, 200000)
    const queries = new NoteVerificationQueryService(database)
    const snapshot = await queries.getRun(id.run, id.user)
    const saved = await database.agentRun.findUniqueOrThrow({
      where: { id: id.run },
      include: { modelExecution: true },
    })
    const task = await database.task.findUniqueOrThrow({
      where: { id: id.task },
      include: { criteria: { orderBy: { position: 'asc' } } },
    })
    const callsBeforeReplay = modelCalls
    const replay = await processor.process(payload)
    assert.equal(modelCalls, callsBeforeReplay)
    assert.equal(replay.reportId, snapshot.report?.id ?? null)
    const accounting = snapshot.report?.body.accounting
    const observation = {
      observedAt: new Date().toISOString(),
      scope:
        'Real GLM + PostgreSQL + Redis; synthetic note/commit/binding; no GitHub request or browser flow',
      model: 'glm-5.3',
      endpoint: endpoint.origin + endpoint.pathname,
      material: {
        lines: lines.map((text, index) => ({ line: index + 1, text })),
        criteria: task.criteria.map(({ id: criterionId, type, description }) => ({
          criterionId,
          type,
          description,
        })),
      },
      run: snapshot,
      modelCalls,
      sameRunReplay: { additionalModelCalls: modelCalls - callsBeforeReplay, ...replay },
      ledger: saved.modelExecution
        ? {
            attemptCount: saved.modelExecution.attemptCount,
            accounting: saved.modelExecution.accounting,
            finishedAt: saved.modelExecution.finishedAt,
          }
        : null,
      taskState: task.state,
      estimatedCostCny: accounting ? accounting.knownCostMicrounits / 1_000_000 : null,
      costNote:
        'Input CNY 8/output CNY 28 per million tokens, user supplied 2026-10-27; cache hits not separated, estimate not provider invoice.',
    }
    await mkdir(outputDirectory, { recursive: true })
    await writeFile(outputFile, `${JSON.stringify(observation, null, 2)}\n`, 'utf8')
    console.log(
      JSON.stringify({
        event: 'live-smoke-result',
        status: snapshot.status,
        errorCode: snapshot.errorCode,
        reportId: snapshot.report?.id ?? null,
        modelCalls,
        estimatedCostCny: observation.estimatedCostCny,
        warnings: accounting?.warnings ?? [],
        replayAdditionalCalls: modelCalls - callsBeforeReplay,
        observationFile: fileURLToPath(outputFile),
      }),
    )
    assert.equal(snapshot.status, 'SUCCEEDED', 'LIVE_RUN_DID_NOT_SUCCEED')
    assert(snapshot.report)
    assert.equal(await database.verificationReport.count({ where: { runId: id.run } }), 1)
    assert.equal(task.state, 'VERIFYING')
  } finally {
    try {
      try {
        await consumer.close()
      } finally {
        try {
          await events.close()
        } finally {
          try {
            await queue.obliterate({ force: true })
          } finally {
            await queue.close()
          }
        }
      }
    } finally {
      try {
        if (seeded)
          await database.$transaction(async (tx) => {
            await tx.outboxEvent.deleteMany({ where: { id: id.event } })
            await tx.agentRun.deleteMany({ where: { id: id.run } })
            await tx.submission.deleteMany({ where: { id: id.submission } })
            await tx.user.deleteMany({ where: { id: id.user } })
            await tx.gitHubInstallation.deleteMany({ where: { id: id.installation } })
          })
      } finally {
        await database.$disconnect()
      }
    }
    console.log(JSON.stringify({ event: 'live-smoke-cleaned', syntheticRunId: id.run }))
  }
}
