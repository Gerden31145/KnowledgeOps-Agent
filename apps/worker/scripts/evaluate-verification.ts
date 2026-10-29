import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import {
  LangChainAnswerVerifier,
  LangChainNoteVerifier,
  type LangChainChatModelConfiguration,
} from '@knowledgeops/agent-core'
import { cases } from './r11-evaluation/cases.js'
import {
  checkCases,
  datasetHash,
  evaluateCase,
  policy,
  summarize,
  type Observation,
  type PromptVersion,
} from './r11-evaluation/evaluate.js'

// 独立评测：不导入数据库/队列，不创建业务记录；仅 --run 才调用付费模型。
const directory = new URL('../.local/', import.meta.url)
const args = process.argv.slice(2)
async function main() {
  checkCases()
  if (args.length === 0 || (args.length === 1 && args[0] === '--check')) {
    console.log(
      JSON.stringify({
        event: 'evaluation-cases-valid',
        samples: cases.length,
        criteria: cases.reduce((s, c) => s + c.expected.length, 0),
        datasetHash: datasetHash(),
        paidCalls: 0,
      }),
    )
    return
  }
  if (args.length === 1 && args[0] === '--results') {
    const files = (await readdir(directory))
      .filter((f) => /^r11-evaluation-.*\.json$/.test(f))
      .sort()
    for (const name of files) {
      const result = JSON.parse(await readFile(new URL(name, directory), 'utf8'))
      console.log(
        JSON.stringify({
          file: name,
          version: result.promptVersion,
          datasetHash: result.datasetHash,
          completed: result.completed,
          stopReason: result.stopReason,
          summary: result.summary,
        }),
      )
    }
    if (!files.length) console.log('尚无真实评测记录。')
    return
  }
  assert(
    args.length === 2 && args[0] === '--run' && ['v1', 'v2'].includes(args[1]!),
    'Usage: pnpm eval:r11 [--check|--results|--run v1|--run v2]',
  )
  const version = args[1] as PromptVersion
  assert(process.env.OPENAI_API_KEY && process.env.OPENAI_BASE_URL, 'MODEL_CONFIGURATION_REQUIRED')
  const endpoint = new URL(process.env.OPENAI_BASE_URL)
  assert(
    endpoint.protocol === 'https:' &&
      endpoint.hostname === 'open.bigmodel.cn' &&
      !endpoint.username &&
      !endpoint.password &&
      !endpoint.search &&
      !endpoint.hash,
    'EXPECTED_GLM_ENDPOINT',
  )
  const method = process.env.PLAN_GENERATION_OUTPUT_METHOD ?? 'jsonMode'
  assert(method === 'jsonMode' || method === 'jsonSchema', 'INVALID_OUTPUT_METHOD')
  const configuration: LangChainChatModelConfiguration = {
    apiKey: process.env.OPENAI_API_KEY,
    baseUrl: endpoint.href,
    structuredOutputMethod: method,
  }
  const ports = {
    note: new LangChainNoteVerifier(configuration),
    answer: new LangChainAnswerVerifier(configuration),
  }
  const startedAt = new Date().toISOString()
  const file = new URL(
    `r11-evaluation-${startedAt.replaceAll(':', '-')}-${version}.json`,
    directory,
  )
  const rows: Observation[] = []
  let stopReason: string | null = null
  const report = () => ({
    datasetVersion: 'r11-v1',
    datasetHash: datasetHash(),
    promptVersion: version,
    model: policy.modelName,
    policy,
    outputMethod: method,
    startedAt,
    completed: rows.length === cases.length,
    stopReason,
    summary: summarize(rows),
    rows,
  })
  await mkdir(directory, { recursive: true })
  await writeFile(file, JSON.stringify(report(), null, 2), { flag: 'wx' })
  console.log(
    JSON.stringify({
      event: 'evaluation-started',
      version,
      samples: cases.length,
      maxCalls: policy.maxCalls,
      currency: policy.currency,
      stopAfterCostMicrounits: policy.stopAfterCostMicrounits,
    }),
  )
  for (const sample of cases) {
    const current = summarize(rows)
    if (rows.length >= policy.maxCalls) {
      stopReason = 'CALL_LIMIT'
      break
    }
    if (current.totalCostMicrounits >= policy.stopAfterCostMicrounits) {
      stopReason = 'COST_STOP'
      break
    }
    // 未知用量不能算作免费，也不继续批量请求。每条已有结果立即保存，失败不自动重跑。
    if (current.unknownUsageCalls > 0) {
      stopReason = 'USAGE_UNKNOWN'
      break
    }
    const row = await evaluateCase(sample, version, ports)
    rows.push(row)
    await writeFile(file, JSON.stringify(report(), null, 2))
    console.log(JSON.stringify({ event: 'evaluation-sample', ...row }))
  }
  await writeFile(file, JSON.stringify(report(), null, 2))
  console.log(
    JSON.stringify({
      event: 'evaluation-finished',
      file: file.pathname,
      ...report(),
      rows: undefined,
    }),
  )
  // 不一致是待分析的测量结果；不能改预期或忽略技术失败来获得退出码 0。
  const summary = summarize(rows)
  if (!report().completed || summary.conclusionAgreement.value !== 1 || summary.technicalFailures)
    process.exitCode = 1
}
await main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: 'evaluation-error',
      code: error instanceof assert.AssertionError ? error.message : 'LOCAL_EVALUATION_ERROR',
    }),
  )
  process.exitCode = 1
})
