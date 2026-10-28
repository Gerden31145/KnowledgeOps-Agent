import { setTimeout as delay } from 'node:timers/promises'
import {
  NoteVerificationModelError,
  type NoteVerificationUsage,
  type NoteVerificationOptions,
  type FollowUpGenerationOptions,
  type AnswerVerificationOptions,
} from '@knowledgeops/agent-core'
import { z } from 'zod'
import { NoteVerificationCandidateError } from './validate-note-verification.js'
import { FollowUpQuestionError } from './validate-follow-up-question.js'
import { AnswerVerificationError } from './verify-follow-up-answer.js'

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
  stepId: 'NOTE_SEMANTICS' | 'GENERATE_FOLLOW_UP' | 'ANSWER_VERIFICATION'
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
export interface NoteVerificationJournal {
  reserve(attempt: NoteVerificationAttempt, accounting: NoteVerificationAccounting): Promise<void>
  settle(attempt: NoteVerificationAttempt, accounting: NoteVerificationAccounting): Promise<void>
}

export type VerificationOutcome<T> =
  { status: 'SUCCEEDED'; value: T } | { status: 'FAILED'; code: string }
export type VerificationExecution<T> = VerificationOutcome<T> & {
  accounting: NoteVerificationAccounting
}
type VerificationCallOptions = Pick<NoteVerificationOptions, 'signal' | 'maxOutputTokens'> & {
  repairReason?: NonNullable<
    | NoteVerificationOptions['repairReason']
    | FollowUpGenerationOptions['repairReason']
    | AnswerVerificationOptions['repairReason']
  >
}
export interface VerificationStep {
  stepId: NoteVerificationAttempt['stepId']
  invoke(options: VerificationCallOptions): Promise<{ usage: NoteVerificationUsage | null }>
}

// 笔记/出题与回答共用预算、取消、修复次数和记账规则；业务流程只决定下一步及合法结果。
// 持久化入口先 claim，再通过 journal 登记/结算；不能据此给队列重试重建预算。
export async function executeVerificationSteps<T>(
  input: { runId: string },
  options: Pick<NoteVerificationOptions, 'signal' | 'maxOutputTokens'>,
  budget: NoteVerificationBudget,
  workflow: {
    next(): VerificationStep | VerificationOutcome<T>
    onModelStop(code: string): VerificationOutcome<T>
  },
  journal?: NoteVerificationJournal,
): Promise<VerificationExecution<T>> {
  const accounting: NoteVerificationAccounting = {
    attempts: [],
    knownTotalTokens: 0,
    knownCostMicrounits: 0,
    usageComplete: true,
    warnings: [],
  }
  const fail = (code: string): VerificationExecution<T> => ({ status: 'FAILED', code, accounting })
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
  const stopModel = (code: string): VerificationExecution<T> => ({
    ...workflow.onModelStop(code),
    accounting,
  })

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
  let repairReason: VerificationCallOptions['repairReason']
  try {
    while (true) {
      const stop = stopped()
      if (stop) return fail(stop)
      const step = workflow.next()
      if ('status' in step) return { ...step, accounting }
      if (!accounting.usageComplete)
        return stopModel(
          accounting.warnings.includes('MODEL_ACCOUNTING_INVALID')
            ? 'MODEL_ACCOUNTING_INVALID'
            : 'MODEL_USAGE_UNKNOWN',
        )
      if (accounting.attempts.length >= limits.maxCalls)
        return stopModel('MODEL_CALL_LIMIT_EXCEEDED')
      if (
        accounting.knownTotalTokens >= limits.maxTotalTokens ||
        accounting.knownCostMicrounits >= limits.maxCostMicrounits
      ) {
        accounting.warnings.push('MODEL_BUDGET_EXCEEDED')
        return stopModel('MODEL_BUDGET_EXCEEDED')
      }

      // 先记一次尝试，再调用；本地校验失败也保守占用次数，不把尝试数冒充供应商请求数。
      const attempt: NoteVerificationAttempt = {
        runId: input.runId,
        stepId: step.stepId,
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
      let response: { usage: NoteVerificationUsage | null } | undefined
      let failure: unknown
      try {
        const callOptions = {
          signal,
          maxOutputTokens: Math.min(
            options.maxOutputTokens,
            limits.maxTotalTokens - accounting.knownTotalTokens,
          ),
        }
        response = await abortable(
          () => step.invoke({ ...callOptions, ...(repairReason ? { repairReason } : {}) }),
          signal,
        )
      } catch (error) {
        failure = error
        attempt.errorCode =
          error instanceof NoteVerificationModelError ||
          error instanceof NoteVerificationCandidateError ||
          error instanceof FollowUpQuestionError ||
          error instanceof AnswerVerificationError
            ? error.code
            : 'MODEL_EXECUTION_ERROR'
      }
      attempt.finishedAt = new Date()
      const reportedUsage =
        response?.usage ??
        (failure instanceof NoteVerificationModelError ||
        failure instanceof NoteVerificationCandidateError ||
        failure instanceof FollowUpQuestionError ||
        failure instanceof AnswerVerificationError
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
      // 合法结果保留；只有剩余额度与完整用量允许时，下一轮才能进入出题。
      if (response) {
        kind = 'INITIAL'
        repairReason = undefined
        continue
      }
      // 没有合法结果时，预算/记账异常仍阻止修复，不发布半份报告。
      if (accounting.warnings.includes('MODEL_ACCOUNTING_INVALID'))
        return stopModel('MODEL_ACCOUNTING_INVALID')
      if (!accounting.usageComplete) {
        const mightRetry =
          failure instanceof NoteVerificationCandidateError ||
          (failure instanceof FollowUpQuestionError &&
            failure.code !== 'INVALID_FOLLOW_UP_CONTEXT') ||
          (failure instanceof AnswerVerificationError &&
            failure.code !== 'INVALID_ANSWER_CONTEXT') ||
          (failure instanceof NoteVerificationModelError &&
            (failure.retryable || failure.code === 'MODEL_OUTPUT_INVALID'))
        return stopModel(
          mightRetry ? 'MODEL_USAGE_UNKNOWN' : (attempt.errorCode ?? 'MODEL_USAGE_UNKNOWN'),
        )
      }
      if (exceeded) return stopModel('MODEL_BUDGET_EXCEEDED')

      if (
        failure instanceof NoteVerificationCandidateError ||
        (failure instanceof FollowUpQuestionError &&
          failure.code !== 'INVALID_FOLLOW_UP_CONTEXT') ||
        (failure instanceof AnswerVerificationError && failure.code !== 'INVALID_ANSWER_CONTEXT') ||
        (failure instanceof NoteVerificationModelError && failure.code === 'MODEL_OUTPUT_INVALID')
      ) {
        repairReason = failure.code as typeof repairReason
        kind = 'REPAIR'
      } else if (failure instanceof NoteVerificationModelError && failure.retryable) {
        repairReason = undefined
        kind = 'RETRY'
      } else {
        return stopModel(attempt.errorCode ?? 'MODEL_EXECUTION_ERROR')
      }
      if (accounting.attempts.length >= limits.maxCalls)
        return stopModel('MODEL_CALL_LIMIT_EXCEEDED')
      // 瞬时错误短暂退避；截止时间仍是同一个，不能每次重试重新计时。
      if (kind === 'RETRY') {
        try {
          await delay(250, undefined, { signal })
        } catch {
          return fail(stopped() ?? 'MODEL_ABORTED')
        }
      }
    }
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
