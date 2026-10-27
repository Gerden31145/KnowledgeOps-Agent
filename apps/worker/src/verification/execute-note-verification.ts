import { setTimeout as delay } from 'node:timers/promises'
import {
  NoteVerificationModelError,
  noteSemanticCriterionTypeSchema,
  type NoteVerificationOptions,
  type NoteVerificationPort,
  type NoteVerificationUsage,
} from '@knowledgeops/agent-core'
import type { CriterionResult } from '@knowledgeops/contracts'
import { z } from 'zod'
import { NoteVerificationCandidateError } from './validate-note-verification.js'
import { verifyNoteSemantics } from './verify-note-semantics.js'

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const noteVerificationBudgetSchema = z.object({
  maxCalls: z.number().int().min(1).max(2),
  maxTotalTokens: integer.positive(),
  maxCostMicrounits: integer.positive(),
  deadlineAt: z.date(),
  // 必须由调用方提供已确认的价格快照；微货币单位 = 一百万分之一元/美元。
  pricing: z.object({
    currency: z.enum(['CNY', 'USD']),
    inputMicrounitsPerMillionTokens: integer,
    outputMicrounitsPerMillionTokens: integer,
  }),
})
const usageSchema = z
  .object({ inputTokens: integer, outputTokens: integer, totalTokens: integer })
  .refine((usage) => usage.totalTokens === usage.inputTokens + usage.outputTokens)

export type NoteVerificationBudget = z.infer<typeof noteVerificationBudgetSchema>
export interface NoteVerificationAttempt {
  runId: string
  stepId: 'NOTE_SEMANTICS'
  attempt: number
  kind: 'INITIAL' | 'RETRY' | 'REPAIR'
  startedAt: Date
  finishedAt: Date
  usage: NoteVerificationUsage | null
  costMicrounits: number | null
  errorCode: string | null
}
export interface NoteVerificationAccounting {
  attempts: NoteVerificationAttempt[]
  knownTotalTokens: number
  knownCostMicrounits: number
  usageComplete: boolean
  // 预算/记账异常与验收结果分开：合法结果可以成功返回，但不能声称预算达标。
  warnings: ('MODEL_BUDGET_EXCEEDED' | 'MODEL_USAGE_UNKNOWN' | 'MODEL_ACCOUNTING_INVALID')[]
}
export type NoteVerificationExecution = (
  { status: 'SUCCEEDED'; results: CriterionResult[] } | { status: 'FAILED'; code: string }
) & { accounting: NoteVerificationAccounting }

export interface NoteVerificationJournal {
  reserve(attempt: NoteVerificationAttempt, accounting: NoteVerificationAccounting): Promise<void>
  settle(attempt: NoteVerificationAttempt, accounting: NoteVerificationAccounting): Promise<void>
}

// 本函数维护单次执行账本；持久化入口通过 journal 在调用前登记、调用后结算。
// 生产消费者必须走 executePersistedNoteVerification，不能直接用此函数重建预算。
// Token/费用按返回用量结算；超限/未知不再调用，但保留已校验的合法结果并标记警告。
// 不是供应商的事前硬额度，也不是实际账单；超时或取消仍拒绝发布结果。
export async function executeNoteVerification(
  port: NoteVerificationPort,
  input: Parameters<typeof verifyNoteSemantics>[1],
  options: Pick<NoteVerificationOptions, 'signal' | 'maxOutputTokens'>,
  budget: NoteVerificationBudget,
  journal?: NoteVerificationJournal,
): Promise<NoteVerificationExecution> {
  const accounting: NoteVerificationAccounting = {
    attempts: [],
    knownTotalTokens: 0,
    knownCostMicrounits: 0,
    usageComplete: true,
    warnings: [],
  }
  const fail = (code: string): NoteVerificationExecution => ({ status: 'FAILED', code, accounting })
  const parsed = noteVerificationBudgetSchema.safeParse(budget)
  if (
    !parsed.success ||
    !Number.isInteger(options.maxOutputTokens) ||
    options.maxOutputTokens < 1 ||
    options.maxOutputTokens > 8_192
  ) {
    return fail('MODEL_BUDGET_CONFIGURATION_ERROR')
  }
  const limits = parsed.data
  const remainingMs = limits.deadlineAt.getTime() - Date.now()
  if (remainingMs <= 0) return fail('RUN_DEADLINE_EXCEEDED')
  if (remainingMs > 86_400_000) return fail('MODEL_BUDGET_CONFIGURATION_ERROR')
  if (options.signal.aborted) return fail('MODEL_ABORTED')
  if (
    !input.criteria.some(
      (criterion) => noteSemanticCriterionTypeSchema.safeParse(criterion.type).success,
    )
  ) {
    return { status: 'SUCCEEDED', results: [], accounting }
  }

  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), remainingMs)
  timer.unref()
  const signal = AbortSignal.any([options.signal, deadline.signal])
  const stopped = () =>
    deadline.signal.aborted || Date.now() >= limits.deadlineAt.getTime()
      ? 'RUN_DEADLINE_EXCEEDED'
      : signal.aborted
        ? 'MODEL_ABORTED'
        : null
  let kind: NoteVerificationAttempt['kind'] = 'INITIAL'
  let repairReason: NoteVerificationOptions['repairReason']
  try {
    while (accounting.attempts.length < limits.maxCalls) {
      const stop = stopped()
      if (stop) return fail(stop)
      if (
        accounting.knownTotalTokens >= limits.maxTotalTokens ||
        accounting.knownCostMicrounits >= limits.maxCostMicrounits
      ) {
        accounting.warnings.push('MODEL_BUDGET_EXCEEDED')
        return fail('MODEL_BUDGET_EXCEEDED')
      }

      // 先记一次尝试，再调用；本地校验失败也保守占用次数，不把尝试数冒充供应商请求数。
      const attempt: NoteVerificationAttempt = {
        runId: input.runId,
        stepId: 'NOTE_SEMANTICS',
        attempt: accounting.attempts.length + 1,
        kind,
        startedAt: new Date(),
        finishedAt: new Date(),
        usage: null,
        costMicrounits: null,
        errorCode: null,
      }
      accounting.attempts.push(attempt)
      // 持久化入口必须先成功登记，才允许请求模型；写库错误向外抛，不能伪装模型失败继续重试。
      await journal?.reserve(attempt, accounting)
      let response: Awaited<ReturnType<typeof verifyNoteSemantics>> | undefined
      let failure: unknown
      try {
        response = await abortable(
          () =>
            verifyNoteSemantics(port, input, {
              signal,
              maxOutputTokens: Math.min(
                options.maxOutputTokens,
                limits.maxTotalTokens - accounting.knownTotalTokens,
              ),
              ...(repairReason ? { repairReason } : {}),
            }),
          signal,
        )
      } catch (error) {
        failure = error
        attempt.errorCode =
          error instanceof NoteVerificationModelError ||
          error instanceof NoteVerificationCandidateError
            ? error.code
            : 'MODEL_EXECUTION_ERROR'
      }
      attempt.finishedAt = new Date()
      const reportedUsage =
        response?.usage ??
        (failure instanceof NoteVerificationModelError ||
        failure instanceof NoteVerificationCandidateError
          ? failure.usage
          : null)
      const checkedUsage = usageSchema.safeParse(reportedUsage)
      if (checkedUsage.success) {
        attempt.usage = checkedUsage.data
        const cost = costOf(checkedUsage.data, limits.pricing)
        if (
          cost === null ||
          !Number.isSafeInteger(accounting.knownTotalTokens + checkedUsage.data.totalTokens) ||
          !Number.isSafeInteger(accounting.knownCostMicrounits + cost)
        ) {
          accounting.usageComplete = false
          accounting.warnings.push('MODEL_ACCOUNTING_INVALID')
        } else {
          attempt.costMicrounits = cost
          accounting.knownTotalTokens += checkedUsage.data.totalTokens
          accounting.knownCostMicrounits += cost
        }
      } else {
        accounting.usageComplete = false
        accounting.warnings.push('MODEL_USAGE_UNKNOWN')
      }
      await journal?.settle(attempt, accounting)
      const afterCallStop = stopped()
      if (afterCallStop) return fail(afterCallStop)
      const exceeded =
        accounting.knownTotalTokens > limits.maxTotalTokens ||
        accounting.knownCostMicrounits > limits.maxCostMicrounits
      if (exceeded) accounting.warnings.push('MODEL_BUDGET_EXCEEDED')
      // 钱已花费：合法结果保留，预算异常单独记录；成功返回后不会继续调用。
      if (response) return { status: 'SUCCEEDED', results: response.results, accounting }
      // 没有合法结果时，预算/记账异常仍阻止修复，不发布半份报告。
      if (accounting.warnings.includes('MODEL_ACCOUNTING_INVALID'))
        return fail('MODEL_ACCOUNTING_INVALID')
      if (!accounting.usageComplete) {
        const mightRetry =
          failure instanceof NoteVerificationCandidateError ||
          (failure instanceof NoteVerificationModelError &&
            (failure.retryable || failure.code === 'MODEL_OUTPUT_INVALID'))
        return fail(
          mightRetry ? 'MODEL_USAGE_UNKNOWN' : (attempt.errorCode ?? 'MODEL_USAGE_UNKNOWN'),
        )
      }
      if (exceeded) return fail('MODEL_BUDGET_EXCEEDED')

      if (
        failure instanceof NoteVerificationCandidateError ||
        (failure instanceof NoteVerificationModelError && failure.code === 'MODEL_OUTPUT_INVALID')
      ) {
        repairReason = failure.code as NoteVerificationOptions['repairReason']
        kind = 'REPAIR'
      } else if (failure instanceof NoteVerificationModelError && failure.retryable) {
        repairReason = undefined
        kind = 'RETRY'
      } else {
        return fail(attempt.errorCode ?? 'MODEL_EXECUTION_ERROR')
      }
      if (accounting.attempts.length >= limits.maxCalls) return fail('MODEL_CALL_LIMIT_EXCEEDED')
      // 瞬时错误短暂退避；截止时间仍是同一个，不能每次重试重新计时。
      if (kind === 'RETRY') {
        try {
          await delay(250, undefined, { signal })
        } catch {
          return fail(stopped() ?? 'MODEL_ABORTED')
        }
      }
    }
    return fail('MODEL_CALL_LIMIT_EXCEEDED')
  } finally {
    clearTimeout(timer)
  }
}

function costOf(
  usage: NoteVerificationUsage,
  pricing: NoteVerificationBudget['pricing'],
): number | null {
  const numerator =
    BigInt(usage.inputTokens) * BigInt(pricing.inputMicrounitsPerMillionTokens) +
    BigInt(usage.outputTokens) * BigInt(pricing.outputMicrounitsPerMillionTokens)
  const cost = (numerator + 999_999n) / 1_000_000n
  return cost <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cost) : null
}

async function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new NoteVerificationModelError('MODEL_ABORTED')
  let onAbort: () => void = () => {}
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new NoteVerificationModelError('MODEL_ABORTED'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    // 替代端口即使不响应取消，调用方也能及时停止；迟到响应不会发布为成功。
    return await Promise.race([operation(), cancelled])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
