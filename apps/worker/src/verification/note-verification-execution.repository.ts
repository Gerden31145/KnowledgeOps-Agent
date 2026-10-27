import { randomUUID } from 'node:crypto'
import { criterionResultSchema, planGenerationModelSnapshotSchema } from '@knowledgeops/contracts'
import { Prisma, type DatabaseClient } from '@knowledgeops/database'
import { z } from 'zod'
import {
  noteVerificationBudgetSchema,
  type NoteVerificationAccounting,
  type NoteVerificationAttempt,
  type NoteVerificationExecution,
} from './execute-note-verification.js'

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const accountingSchema = z.object({
  attempts: z
    .array(
      z.object({
        runId: z.uuid(),
        stepId: z.literal('NOTE_SEMANTICS'),
        attempt: z.number().int().min(1).max(2),
        kind: z.enum(['INITIAL', 'RETRY', 'REPAIR']),
        startedAt: z.coerce.date(),
        finishedAt: z.coerce.date(),
        usage: z.object({ inputTokens: count, outputTokens: count, totalTokens: count }).nullable(),
        costMicrounits: count.nullable(),
        errorCode: z.string().max(64).nullable(),
      }),
    )
    .max(2),
  knownTotalTokens: count,
  knownCostMicrounits: count,
  usageComplete: z.boolean(),
  warnings: z
    .array(z.enum(['MODEL_BUDGET_EXCEEDED', 'MODEL_USAGE_UNKNOWN', 'MODEL_ACCOUNTING_INVALID']))
    .max(3),
})
export const noteExecutionResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('SUCCEEDED'),
    results: z.array(criterionResultSchema).max(6),
    accounting: accountingSchema,
  }),
  z.object({
    status: z.literal('FAILED'),
    code: z.string().min(1).max(64),
    accounting: accountingSchema,
  }),
])
export const noteExecutionConfigurationSchema = z.object({
  model: planGenerationModelSnapshotSchema,
  budget: noteVerificationBudgetSchema.extend({ deadlineAt: z.coerce.date() }),
  maxOutputTokens: z.number().int().min(1).max(8_192),
})
export type NoteExecutionConfiguration = z.infer<typeof noteExecutionConfigurationSchema>
export type NoteExecutionClaim = { runId: string; claimToken: string; runVersion: number }
export type NoteExecutionClaimResult =
  | { status: 'CLAIMED'; claim: NoteExecutionClaim; configuration: NoteExecutionConfiguration }
  | { status: 'REPLAYED'; result: NoteVerificationExecution }
  | {
      status: 'SKIPPED'
      reason:
        'RUN_TERMINAL' | 'RUN_CANCEL_REQUESTED' | 'EXECUTION_IN_PROGRESS' | 'RUN_DEADLINE_EXCEEDED'
    }

export class NoteVerificationPersistenceError extends Error {
  constructor(
    readonly code:
      | 'RUN_NOT_EXECUTABLE'
      | 'EXECUTION_CONTEXT_CHANGED'
      | 'EXECUTION_CHECKPOINT_CONFLICT'
      | 'EXECUTION_CHECKPOINT_INVALID',
  ) {
    super(code)
  }
}

// 这里只管理账本，不改变 AgentRun/Task 业务状态，也不承担用户鉴权和仓库绑定校验。
// 消费者必须先校验当前绑定、Task 版本和证据；落报告前还需再次复核。
export class NoteVerificationExecutionRepository {
  constructor(
    private readonly database: DatabaseClient,
    private readonly clock = () => new Date(),
  ) {}

  async claim(input: {
    runId: string
    taskId: string
    fingerprint: string
    configuration: NoteExecutionConfiguration
  }): Promise<NoteExecutionClaimResult> {
    return this.database.$transaction(async (tx) => {
      const run = await lockRun(tx, input.runId)
      if (!run || run.taskId !== input.taskId || run.kind !== 'NOTE_VERIFICATION')
        throw new NoteVerificationPersistenceError('RUN_NOT_EXECUTABLE')
      if (!isActive(run.status))
        return {
          status: 'SKIPPED',
          reason: run.status === 'CANCEL_REQUESTED' ? 'RUN_CANCEL_REQUESTED' : 'RUN_TERMINAL',
        }
      const saved = await tx.noteVerificationExecution.findUnique({ where: { runId: input.runId } })
      if (saved) {
        if (saved.requestFingerprint !== input.fingerprint || saved.runVersion !== run.version)
          throw new NoteVerificationPersistenceError('EXECUTION_CONTEXT_CHANGED')
        if (saved.result !== null)
          return { status: 'REPLAYED', result: decode(noteExecutionResultSchema, saved.result) }
        // 无论是正在运行还是进程已退出，都不重新获得一份预算；未完成记录交消费者对账处理。
        return {
          status: 'SKIPPED',
          reason:
            saved.deadlineAt <= this.clock() ? 'RUN_DEADLINE_EXCEEDED' : 'EXECUTION_IN_PROGRESS',
        }
      }
      const configuration = decode(noteExecutionConfigurationSchema, input.configuration)
      if (configuration.budget.deadlineAt <= this.clock())
        return { status: 'SKIPPED', reason: 'RUN_DEADLINE_EXCEEDED' }
      const claim = { runId: input.runId, claimToken: randomUUID(), runVersion: run.version }
      await tx.noteVerificationExecution.create({
        data: {
          ...claim,
          requestFingerprint: input.fingerprint,
          configuration: json(configuration),
          deadlineAt: configuration.budget.deadlineAt,
          accounting: json({
            attempts: [],
            knownTotalTokens: 0,
            knownCostMicrounits: 0,
            usageComplete: true,
            warnings: [],
          }),
        },
      })
      return { status: 'CLAIMED', claim, configuration }
    })
  }

  reserve(
    claim: NoteExecutionClaim,
    attempt: NoteVerificationAttempt,
    accounting: NoteVerificationAccounting,
  ): Promise<void> {
    return this.write(claim, async (tx, saved) => {
      const checked = checkedAccounting(claim, accounting)
      const configuration = decode(noteExecutionConfigurationSchema, saved.configuration)
      if (
        saved.deadlineAt <= this.clock() ||
        saved.pendingAttempt !== null ||
        attempt.attempt !== saved.attemptCount + 1 ||
        attempt.attempt > configuration.budget.maxCalls ||
        checked.attempts.length !== attempt.attempt
      )
        throw new NoteVerificationPersistenceError('EXECUTION_CHECKPOINT_CONFLICT')
      await tx.noteVerificationExecution.update({
        where: { runId: claim.runId },
        data: {
          attemptCount: attempt.attempt,
          pendingAttempt: attempt.attempt,
          accounting: json(checked),
        },
      })
    })
  }

  settle(
    claim: NoteExecutionClaim,
    attempt: NoteVerificationAttempt,
    accounting: NoteVerificationAccounting,
  ): Promise<void> {
    return this.write(claim, async (tx, saved) => {
      const checked = checkedAccounting(claim, accounting)
      if (
        saved.pendingAttempt !== attempt.attempt ||
        saved.attemptCount !== attempt.attempt ||
        checked.attempts.length !== attempt.attempt
      )
        throw new NoteVerificationPersistenceError('EXECUTION_CHECKPOINT_CONFLICT')
      await tx.noteVerificationExecution.update({
        where: { runId: claim.runId },
        data: {
          pendingAttempt: null,
          accounting: json(checked),
        },
      })
    })
  }

  finish(claim: NoteExecutionClaim, result: NoteVerificationExecution): Promise<void> {
    return this.write(claim, async (tx, saved) => {
      const checked = decode(noteExecutionResultSchema, result)
      checkedAccounting(claim, checked.accounting)
      if (
        saved.pendingAttempt !== null ||
        checked.accounting.attempts.length !== saved.attemptCount ||
        (checked.status === 'SUCCEEDED' && saved.deadlineAt <= this.clock())
      )
        throw new NoteVerificationPersistenceError('EXECUTION_CHECKPOINT_CONFLICT')
      await tx.noteVerificationExecution.update({
        where: { runId: claim.runId },
        data: {
          result: json(checked),
          accounting: json(checked.accounting),
          finishedAt: this.clock(),
        },
      })
    })
  }

  private async write(
    claim: NoteExecutionClaim,
    operation: (
      tx: Prisma.TransactionClient,
      saved: Prisma.NoteVerificationExecutionGetPayload<object>,
    ) => Promise<void>,
  ): Promise<void> {
    await this.database.$transaction(async (tx) => {
      const run = await lockRun(tx, claim.runId)
      if (!run || !isActive(run.status) || run.version !== claim.runVersion)
        throw new NoteVerificationPersistenceError('RUN_NOT_EXECUTABLE')
      const saved = await tx.noteVerificationExecution.findUnique({ where: { runId: claim.runId } })
      if (
        !saved ||
        saved.claimToken !== claim.claimToken ||
        saved.runVersion !== claim.runVersion ||
        saved.result !== null
      )
        throw new NoteVerificationPersistenceError('EXECUTION_CHECKPOINT_CONFLICT')
      await operation(tx, saved)
    })
  }
}

async function lockRun(tx: Prisma.TransactionClient, runId: string) {
  const [run] = await tx.$queryRaw<
    { taskId: string; kind: string; status: string; version: number }[]
  >(Prisma.sql`
    SELECT task_id AS "taskId", kind::text, status::text, version FROM agent_runs
    WHERE id = ${runId}::uuid FOR UPDATE
  `)
  return run
}
function isActive(status: string) {
  return status === 'QUEUED' || status === 'RUNNING'
}
function checkedAccounting(claim: NoteExecutionClaim, value: NoteVerificationAccounting) {
  const checked = decode(accountingSchema, value)
  if (
    checked.attempts.some(
      (attempt, index) => attempt.runId !== claim.runId || attempt.attempt !== index + 1,
    )
  )
    throw new NoteVerificationPersistenceError('EXECUTION_CHECKPOINT_INVALID')
  return checked
}
function decode<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new NoteVerificationPersistenceError('EXECUTION_CHECKPOINT_INVALID')
  return parsed.data
}
function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
}
