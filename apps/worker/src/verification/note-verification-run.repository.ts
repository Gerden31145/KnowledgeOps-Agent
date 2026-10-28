import { randomUUID } from 'node:crypto'
import {
  NOTE_VERIFICATION_OUTPUT_SCHEMA_VERSION,
  NOTE_VERIFICATION_PROMPT_VERSION,
  FOLLOW_UP_PROMPT_VERSION,
  FOLLOW_UP_OUTPUT_SCHEMA_VERSION,
  noteSemanticCriterionTypeSchema,
} from '@knowledgeops/agent-core'
import {
  isAgentRunTerminalState,
  NOTE_VERIFICATION_WORKFLOW_VERSION,
  noteVerificationReportBodySchema,
  type NoteVerificationRequestedPayload,
} from '@knowledgeops/contracts'
import { Prisma, type DatabaseClient } from '@knowledgeops/database'
import type { WorkerEnvironment } from '../config/environment.js'
import { checkNoteCriteria } from './check-note-criteria.js'
import { noteExecutionFingerprint } from './execute-persisted-note-verification.js'
import {
  noteExecutionConfigurationSchema,
  noteExecutionResultSchema,
  type NoteExecutionConfiguration,
} from './note-verification-execution.repository.js'
import { NoteEvidenceError, parseNoteEvidence } from './parse-note-evidence.js'
import { canGenerateFollowUp } from './execute-note-verification.js'
import { validateFollowUpQuestion, FollowUpQuestionError } from './validate-follow-up-question.js'

const include = {
  task: {
    include: {
      criteria: { orderBy: { position: 'asc' as const } },
      stage: { include: { plan: { include: { goal: true } } } },
    },
  },
  submission: { include: { repository: true, evidence: true } },
  modelExecution: true,
  report: true,
} satisfies Prisma.AgentRunInclude
type Run = Prisma.AgentRunGetPayload<{ include: typeof include }>
import {
  terminateVerificationRun as terminate,
  verificationRunSnapshot as snapshot,
  ignoredVerificationRun as ignored,
  type VerificationRunResult as NoteRunResult,
} from './verification-run-lifecycle.js'
export type { VerificationRunResult as NoteRunResult } from './verification-run-lifecycle.js'

// 领取与最终写入都按 User → Task → Run 加锁；网络/模型调用不放进数据库事务。
export class NoteVerificationRunRepository {
  constructor(
    private readonly database: DatabaseClient,
    private readonly environment: WorkerEnvironment,
    private readonly clock = () => new Date(),
  ) {}

  async prepare(message: NoteVerificationRequestedPayload) {
    return this.database.$transaction(async (tx) => {
      let run = await this.lock(tx, message)
      if (!run) return { ready: false as const, result: ignored(message.runId) }
      if (isAgentRunTerminalState(run.status))
        return { ready: false as const, result: snapshot(run) }
      if (run.status === 'QUEUED') {
        const configuration = this.newConfiguration()
        run = await tx.agentRun.update({
          where: { id: run.id },
          data: {
            status: 'RUNNING',
            startedAt: this.clock(),
            version: { increment: 1 },
            deadlineAt: configuration.budget.deadlineAt,
            executionConfiguration: json(configuration),
          },
          include,
        })
      }
      const invalid = eligibility(run, this.clock())
      if (invalid)
        return { ready: false as const, result: await terminate(tx, run, invalid, this.clock()) }
      const configuration = noteExecutionConfigurationSchema.safeParse(run.executionConfiguration)
      if (
        !configuration.success ||
        configuration.data.budget.deadlineAt.getTime() !== run.deadlineAt?.getTime()
      )
        return {
          ready: false as const,
          result: await terminate(tx, run, 'EXECUTION_CONTEXT_CHANGED', this.clock()),
        }
      try {
        const context = material(run, configuration.data)
        return { ready: true as const, input: context.input, configuration: configuration.data }
      } catch (error) {
        if (!(error instanceof NoteEvidenceError)) throw error
        return {
          ready: false as const,
          result: await terminate(tx, run, 'INVALID_EVIDENCE', this.clock()),
        }
      }
    })
  }

  // 官方报告与 Run 终态必须同成同败；账本已经保存的结果允许在事务失败后重用。
  async finalize(message: NoteVerificationRequestedPayload): Promise<NoteRunResult> {
    return this.database.$transaction(async (tx) => {
      const run = await this.lock(tx, message)
      if (!run) return ignored(message.runId)
      if (isAgentRunTerminalState(run.status)) return snapshot(run)
      const invalid = eligibility(run, this.clock())
      if (invalid) return terminate(tx, run, invalid, this.clock())
      const ledger = run.modelExecution
      if (!ledger?.result) return { ...snapshot(run), status: 'PENDING' }
      const config = noteExecutionConfigurationSchema.safeParse(run.executionConfiguration)
      const saved = noteExecutionResultSchema.safeParse(ledger.result)
      if (
        !config.success ||
        !saved.success ||
        ledger.runVersion !== run.version ||
        ledger.deadlineAt.getTime() !== run.deadlineAt?.getTime() ||
        config.data.budget.deadlineAt.getTime() !== run.deadlineAt?.getTime()
      )
        return terminate(tx, run, 'EXECUTION_CONTEXT_CHANGED', this.clock())
      if (saved.data.status === 'FAILED') return terminate(tx, run, saved.data.code, this.clock())
      let context: ReturnType<typeof material>
      try {
        context = material(run, config.data)
      } catch (error) {
        if (!(error instanceof NoteEvidenceError)) throw error
        return terminate(tx, run, 'INVALID_EVIDENCE', this.clock())
      }
      if (ledger.requestFingerprint !== noteExecutionFingerprint(context.input))
        return terminate(tx, run, 'EXECUTION_CONTEXT_CHANGED', this.clock())
      const followUp = saved.data.followUp
      if (context.input.followUp && !followUp)
        return terminate(tx, run, 'EXECUTION_CONTEXT_CHANGED', this.clock())
      let question: ReturnType<typeof validateFollowUpQuestion> | undefined
      if (followUp?.status === 'READY') {
        const expected = context.input.followUp
        if (
          !expected ||
          !canGenerateFollowUp(expected, saved.data.results) ||
          followUp.question.criterionId !== expected.criterion.id ||
          Object.entries({ ...expected.source, ...context.input.note.source }).some(
            ([key, value]) =>
              followUp.question.source[key as keyof typeof followUp.question.source] !== value,
          )
        )
          return terminate(tx, run, 'EXECUTION_CONTEXT_CHANGED', this.clock())
        try {
          question = validateFollowUpQuestion({
            ...expected,
            note: context.input.note,
            candidate: {
              question: followUp.question.question,
              rubric: followUp.question.rubric,
              citations: followUp.question.citations.map(({ startLine, endLine, excerpt }) => ({
                startLine,
                endLine,
                excerpt,
              })),
            },
          })
        } catch (error) {
          if (!(error instanceof FollowUpQuestionError)) throw error
          return terminate(tx, run, 'EXECUTION_CONTEXT_CHANGED', this.clock())
        }
      }
      const semanticIds = new Set(saved.data.results.map((result) => result.criterionId))
      const accounting = saved.data.accounting
      const body = noteVerificationReportBodySchema.parse({
        results: [...context.checks.results, ...saved.data.results],
        exemptions: context.checks.exemptions,
        pendingCriterionIds: context.checks.pendingCriterionIds.filter(
          (id) => !semanticIds.has(id),
        ),
        followUp: followUp?.status === 'READY' ? { status: 'READY' } : (followUp ?? null),
        accounting: {
          knownTotalTokens: accounting.knownTotalTokens,
          knownCostMicrounits: accounting.knownCostMicrounits,
          currency: config.data.budget.pricing.currency,
          usageComplete: accounting.usageComplete,
          warnings: accounting.warnings,
        },
      })
      if (run.deadlineAt && run.deadlineAt <= this.clock())
        return terminate(tx, run, 'RUN_DEADLINE_EXCEEDED', this.clock())
      const report = await tx.verificationReport.create({
        data: {
          ...(config.data.followUp ? { id: config.data.followUp.reportId } : {}),
          runId: run.id,
          body: json(body),
        },
      })
      if (question)
        await tx.followUpQuestion.create({ data: { reportId: report.id, body: json(question) } })
      await tx.agentRun.update({
        where: { id: run.id },
        data: {
          status: 'SUCCEEDED',
          version: { increment: 1 },
          finishedAt: this.clock(),
          errorCode: null,
        },
      })
      // 报告、唯一追问与 Run 终态同事务；回答尚未验收，Task 汇总仍留给 R11。
      return { runId: run.id, status: 'SUCCEEDED', reportId: report.id }
    })
  }

  // 只补已有结果或收束过期/取消的 Run，绝不由扫描器重新调用模型。
  async reconcile(
    limit: number,
    queueFailed?: (message: NoteVerificationRequestedPayload) => Promise<boolean>,
  ): Promise<number> {
    const runs = await this.database.agentRun.findMany({
      where: {
        kind: 'NOTE_VERIFICATION',
        submissionId: { not: null },
        OR: [
          { status: 'CANCEL_REQUESTED' },
          {
            status: 'RUNNING',
            OR: [
              { deadlineAt: { lte: this.clock() } },
              { modelExecution: { is: { finishedAt: { not: null } } } },
            ],
          },
        ],
      },
      orderBy: [{ deadlineAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true, submissionId: true },
    })
    let completed = 0
    for (const run of runs) {
      if (!run.submissionId) continue
      const result = await this.finalize({ runId: run.id, submissionId: run.submissionId })
      if (result.status !== 'PENDING' && result.status !== 'IGNORED') completed++
    }
    // 数据库在首次领取前不可用时，Job 也可能耗尽重试；此时尚无 deadline/账本。
    if (queueFailed) {
      const queued = await this.database.agentRun.findMany({
        where: {
          kind: 'NOTE_VERIFICATION',
          status: 'QUEUED',
          submissionId: { not: null },
        },
        orderBy: [{ queuedAt: 'asc' }, { id: 'asc' }],
        take: limit,
        select: { id: true, submissionId: true },
      })
      for (const candidate of queued) {
        if (!candidate.submissionId) continue
        const message = { runId: candidate.id, submissionId: candidate.submissionId }
        if (!(await queueFailed(message))) continue
        const changed = await this.database.$transaction(async (tx) => {
          const run = await this.lock(tx, message)
          if (!run || run.status !== 'QUEUED') return false
          await terminate(tx, run, 'NOTE_QUEUE_FAILED', this.clock())
          return true
        })
        if (changed) completed++
      }
    }
    return completed
  }

  private async lock(
    tx: Prisma.TransactionClient,
    message: NoteVerificationRequestedPayload,
  ): Promise<Run | null> {
    const owner = await tx.agentRun.findUnique({
      where: { id: message.runId },
      select: {
        taskId: true,
        submissionId: true,
        kind: true,
        task: {
          select: {
            stage: { select: { plan: { select: { goal: { select: { userId: true } } } } } },
          },
        },
      },
    })
    if (!owner || owner.submissionId !== message.submissionId || owner.kind !== 'NOTE_VERIFICATION')
      return null
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM users WHERE id = ${owner.task.stage.plan.goal.userId}::uuid FOR UPDATE`,
    )
    await tx.$queryRaw(Prisma.sql`SELECT id FROM tasks WHERE id = ${owner.taskId}::uuid FOR UPDATE`)
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM agent_runs WHERE id = ${message.runId}::uuid FOR UPDATE`,
    )
    return tx.agentRun.findUnique({ where: { id: message.runId }, include })
  }

  private newConfiguration(): NoteExecutionConfiguration {
    const model = this.environment.NOTE_VERIFICATION_MODEL_JSON
    if (!model) throw new Error('NOTE_VERIFICATION_NOT_CONFIGURED')
    return noteExecutionConfigurationSchema.parse({
      model: {
        catalogId: model.catalogId,
        provider: 'openai',
        modelName: model.modelName,
        promptVersion: NOTE_VERIFICATION_PROMPT_VERSION,
        outputSchemaVersion: NOTE_VERIFICATION_OUTPUT_SCHEMA_VERSION,
      },
      followUp: {
        reportId: randomUUID(),
        model: {
          catalogId: model.catalogId,
          provider: 'openai',
          modelName: model.modelName,
          promptVersion: FOLLOW_UP_PROMPT_VERSION,
          outputSchemaVersion: FOLLOW_UP_OUTPUT_SCHEMA_VERSION,
        },
      },
      maxOutputTokens: this.environment.NOTE_VERIFICATION_MAX_OUTPUT_TOKENS,
      budget: {
        maxCalls: 2,
        maxTotalTokens: this.environment.NOTE_VERIFICATION_MAX_TOTAL_TOKENS,
        maxCostMicrounits: this.environment.NOTE_VERIFICATION_MAX_COST_MICROUNITS,
        deadlineAt: new Date(
          this.clock().getTime() + this.environment.NOTE_VERIFICATION_TIMEOUT_MS,
        ),
        pricing: {
          currency: model.currency,
          inputMicrounitsPerMillionTokens: model.inputMicrounitsPerMillionTokens,
          outputMicrounitsPerMillionTokens: model.outputMicrounitsPerMillionTokens,
        },
      },
    })
  }
}

function eligibility(run: Run, now: Date): string | null {
  if (run.status === 'CANCEL_REQUESTED') return 'RUN_CANCEL_REQUESTED'
  if (run.deadlineAt && run.deadlineAt <= now) return 'RUN_DEADLINE_EXCEEDED'
  const submission = run.submission
  if (
    run.workflowVersion !== NOTE_VERIFICATION_WORKFLOW_VERSION ||
    !submission ||
    submission.taskId !== run.taskId ||
    submission.repository.userId !== run.task.stage.plan.goal.userId
  )
    return 'EXECUTION_CONTEXT_CHANGED'
  if (!submission.repository.enabled) return 'REPOSITORY_BINDING_CHANGED'
  if (
    run.task.stage.plan.status !== 'ACTIVE' ||
    run.task.state !== 'VERIFYING' ||
    run.task.version !== run.expectedTaskVersion ||
    run.task.targetPath !== submission.targetPath
  )
    return 'TASK_CONTEXT_CHANGED'
  return null
}
function material(run: Run, configuration: NoteExecutionConfiguration) {
  const submission = run.submission
  const evidence = submission?.evidence
  if (!submission || !evidence || evidence.sourceCommitSha !== submission.afterCommitSha)
    throw new NoteEvidenceError('INVALID_EVIDENCE')
  const fixed = { ...evidence, repositoryId: submission.repositoryId, path: submission.targetPath }
  const checks = checkNoteCriteria({ evidence: fixed, criteria: run.task.criteria })
  const questionCriteria = run.task.criteria.filter(({ type }) => type === 'FOLLOW_UP_ANSWER')
  if (configuration.followUp && questionCriteria.length > 1)
    throw new NoteEvidenceError('INVALID_EVIDENCE')
  const criterion = questionCriteria[0]
  const semantic = (type: string) => noteSemanticCriterionTypeSchema.safeParse(type).success
  const followUp =
    configuration.followUp && criterion
      ? {
          source: {
            taskId: run.taskId,
            submissionId: submission.id,
            noteRunId: run.id,
            reportId: configuration.followUp.reportId,
          },
          model: configuration.followUp.model,
          criterion: {
            id: criterion.id,
            type: 'FOLLOW_UP_ANSWER' as const,
            description: criterion.description,
          },
          deterministicPassed: run.task.criteria
            .filter((c) => c.required && c.type !== 'FOLLOW_UP_ANSWER' && !semantic(c.type))
            .every(
              (c) =>
                checks.results.some((r) => r.criterionId === c.id && r.outcome === 'PASSED') ||
                checks.exemptions.some((e) => e.criterionId === c.id),
            ),
          requiredSemanticIds: run.task.criteria
            .filter((c) => c.required && semantic(c.type))
            .map((c) => c.id),
        }
      : undefined
  return {
    checks,
    input: {
      runId: run.id,
      model: configuration.model,
      task: { id: run.task.id, title: run.task.title, description: run.task.description },
      criteria: run.task.criteria.map(({ id, type, description }) => ({ id, type, description })),
      note: parseNoteEvidence(fixed),
      ...(followUp ? { followUp } : {}),
    },
  }
}
function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
}
