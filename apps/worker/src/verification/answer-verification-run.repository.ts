import { isDeepStrictEqual } from 'node:util'
import {
  ANSWER_VERIFICATION_PROMPT_VERSION,
  ANSWER_VERIFICATION_OUTPUT_SCHEMA_VERSION,
} from '@knowledgeops/agent-core'
import {
  ANSWER_VERIFICATION_WORKFLOW_VERSION,
  answerVerificationReportBodySchema,
  followUpQuestionDraftSchema,
  isAgentRunTerminalState,
  noteVerificationReportBodySchema,
  type AnswerVerificationRequestedPayload,
} from '@knowledgeops/contracts'
import { Prisma, type DatabaseClient } from '@knowledgeops/database'
import type { WorkerEnvironment } from '../config/environment.js'
import {
  answerExecutionFingerprint,
  answerExecutionResultSchema,
} from './execute-persisted-answer-verification.js'
import {
  noteExecutionConfigurationSchema,
  type NoteExecutionConfiguration,
} from './note-verification-execution.repository.js'
import { NoteEvidenceError, parseNoteEvidence } from './parse-note-evidence.js'
import { AnswerVerificationError, validateAnswerVerification } from './verify-follow-up-answer.js'
import {
  terminateVerificationRun as terminate,
  verificationRunSnapshot as snapshot,
  ignoredVerificationRun as ignored,
  type VerificationRunResult,
} from './verification-run-lifecycle.js'

const include = {
  task: { include: { criteria: true, stage: { include: { plan: { include: { goal: true } } } } } },
  answerSubmission: {
    include: {
      question: {
        include: {
          report: {
            include: {
              run: { include: { submission: { include: { repository: true, evidence: true } } } },
            },
          },
        },
      },
    },
  },
  modelExecution: true,
  report: true,
} satisfies Prisma.AgentRunInclude
type Run = Prisma.AgentRunGetPayload<{ include: typeof include }>
const configurationSchema = noteExecutionConfigurationSchema.omit({ followUp: true }).strict()

// 模型调用在事务外；领取和最终写入均按 User → Task → Run 加锁并复核原题资格。
export class AnswerVerificationRunRepository {
  constructor(
    private readonly database: DatabaseClient,
    private readonly environment: WorkerEnvironment,
    private readonly clock = () => new Date(),
  ) {}

  async prepare(message: AnswerVerificationRequestedPayload) {
    return this.database.$transaction(async (tx) => {
      let run = await this.lock(tx, message)
      if (!run) return { ready: false as const, result: ignored(message.runId) }
      if (isAgentRunTerminalState(run.status))
        return { ready: false as const, result: snapshot(run) }
      const invalid = await eligibility(tx, run, this.clock())
      if (invalid)
        return { ready: false as const, result: await terminate(tx, run, invalid, this.clock()) }
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
      const configuration = configurationSchema.safeParse(run.executionConfiguration)
      if (
        !configuration.success ||
        configuration.data.budget.deadlineAt.getTime() !== run.deadlineAt?.getTime()
      )
        return {
          ready: false as const,
          result: await terminate(tx, run, 'EXECUTION_CONTEXT_CHANGED', this.clock()),
        }
      try {
        return {
          ready: true as const,
          input: material(run, configuration.data),
          configuration: configuration.data,
        }
      } catch (error) {
        if (!(error instanceof NoteEvidenceError)) throw error
        return {
          ready: false as const,
          result: await terminate(tx, run, 'INVALID_EVIDENCE', this.clock()),
        }
      }
    })
  }

  async finalize(message: AnswerVerificationRequestedPayload): Promise<VerificationRunResult> {
    return this.database.$transaction(async (tx) => {
      const run = await this.lock(tx, message)
      if (!run) return ignored(message.runId)
      if (isAgentRunTerminalState(run.status)) return snapshot(run)
      const invalid = await eligibility(tx, run, this.clock())
      if (invalid) return terminate(tx, run, invalid, this.clock())
      const ledger = run.modelExecution
      if (!ledger?.result) return { ...snapshot(run), status: 'PENDING' }
      const config = configurationSchema.safeParse(run.executionConfiguration)
      const saved = answerExecutionResultSchema.safeParse(ledger.result)
      if (
        !config.success ||
        !saved.success ||
        ledger.runVersion !== run.version ||
        ledger.pendingAttempt !== null ||
        ledger.finishedAt === null ||
        ledger.deadlineAt.getTime() !== run.deadlineAt?.getTime() ||
        config.data.budget.deadlineAt.getTime() !== run.deadlineAt?.getTime() ||
        !isDeepStrictEqual(json(config.data), ledger.configuration)
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
      if (ledger.requestFingerprint !== answerExecutionFingerprint(context))
        return terminate(tx, run, 'EXECUTION_CONTEXT_CHANGED', this.clock())
      const result = saved.data.result
      try {
        const checked = validateAnswerVerification(
          {
            ...context,
            note: { ...context.note.source, lines: context.note.lines },
          },
          {
            outcome: result.outcome,
            rationale: result.rationale,
            suggestions: result.suggestions,
            confidence: result.confidence,
            citations: result.citations.map(({ startLine, endLine, excerpt }) => ({
              startLine,
              endLine,
              excerpt,
            })),
            answerCitations: result.answerCitations.map(({ startLine, endLine, excerpt }) => ({
              startLine,
              endLine,
              excerpt,
            })),
          },
        )
        if (!isDeepStrictEqual(checked, result))
          return terminate(tx, run, 'EXECUTION_CONTEXT_CHANGED', this.clock())
      } catch (error) {
        if (!(error instanceof AnswerVerificationError)) throw error
        return terminate(tx, run, 'EXECUTION_CONTEXT_CHANGED', this.clock())
      }
      const { accounting } = saved.data
      const body = answerVerificationReportBodySchema.parse({
        source: context.question.source,
        result,
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
        data: { runId: run.id, body: json(body) },
      })
      await tx.agentRun.update({
        where: { id: run.id },
        data: {
          status: 'SUCCEEDED',
          version: { increment: 1 },
          finishedAt: this.clock(),
          errorCode: null,
        },
      })
      // 回答 FAILED/不足也是有效报告；Run 成功不代表 Task 通过，Task 汇总由 R11 接入。
      return { runId: run.id, status: 'SUCCEEDED', reportId: report.id }
    })
  }

  // 恢复已有账本或收束取消/超时；不重调模型，也不凭队列丢失猜测运行结果。
  async reconcile(
    limit: number,
    queueFailed?: (message: AnswerVerificationRequestedPayload) => Promise<boolean>,
  ) {
    const runs = await this.database.agentRun.findMany({
      where: {
        kind: 'ANSWER_VERIFICATION',
        answerSubmissionId: { not: null },
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
      select: { id: true, answerSubmissionId: true },
    })
    let completed = 0
    for (const run of runs) {
      const result = await this.finalize({
        runId: run.id,
        answerSubmissionId: run.answerSubmissionId!,
      })
      if (result.status !== 'PENDING' && result.status !== 'IGNORED') completed++
    }
    if (queueFailed) {
      const queued = await this.database.agentRun.findMany({
        where: {
          kind: 'ANSWER_VERIFICATION',
          status: 'QUEUED',
          answerSubmissionId: { not: null },
        },
        orderBy: [{ queuedAt: 'asc' }, { id: 'asc' }],
        take: limit,
        select: { id: true, answerSubmissionId: true },
      })
      for (const candidate of queued) {
        const message = { runId: candidate.id, answerSubmissionId: candidate.answerSubmissionId! }
        if (!(await queueFailed(message))) continue
        const changed = await this.database.$transaction(async (tx) => {
          const run = await this.lock(tx, message)
          if (!run || run.status !== 'QUEUED') return false
          await terminate(tx, run, 'ANSWER_QUEUE_FAILED', this.clock())
          return true
        })
        if (changed) completed++
      }
    }
    return completed
  }

  private async lock(
    tx: Prisma.TransactionClient,
    message: AnswerVerificationRequestedPayload,
  ): Promise<Run | null> {
    const owner = await tx.agentRun.findUnique({
      where: { id: message.runId },
      select: {
        taskId: true,
        answerSubmissionId: true,
        kind: true,
        task: {
          select: {
            stage: { select: { plan: { select: { goal: { select: { userId: true } } } } } },
          },
        },
      },
    })
    if (
      !owner ||
      owner.kind !== 'ANSWER_VERIFICATION' ||
      owner.answerSubmissionId !== message.answerSubmissionId
    )
      return null
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM users WHERE id = ${owner.task.stage.plan.goal.userId}::uuid FOR UPDATE`,
    )
    await tx.$queryRaw(Prisma.sql`SELECT id FROM tasks WHERE id = ${owner.taskId}::uuid FOR UPDATE`)
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM agent_runs WHERE id = ${message.runId}::uuid FOR UPDATE`,
    )
    const locked = await tx.agentRun.findUnique({ where: { id: message.runId }, include })
    return locked?.kind === 'ANSWER_VERIFICATION' &&
      locked.answerSubmissionId === message.answerSubmissionId &&
      locked.taskId === owner.taskId
      ? locked
      : null
  }

  private newConfiguration() {
    const model = this.environment.NOTE_VERIFICATION_MODEL_JSON
    if (!model) throw new Error('ANSWER_VERIFICATION_NOT_CONFIGURED')
    return configurationSchema.parse({
      model: {
        catalogId: model.catalogId,
        provider: 'openai',
        modelName: model.modelName,
        promptVersion: ANSWER_VERIFICATION_PROMPT_VERSION,
        outputSchemaVersion: ANSWER_VERIFICATION_OUTPUT_SCHEMA_VERSION,
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

async function eligibility(
  tx: Prisma.TransactionClient,
  run: Run,
  now: Date,
): Promise<string | null> {
  if (run.status === 'CANCEL_REQUESTED') return 'RUN_CANCEL_REQUESTED'
  if (run.deadlineAt && run.deadlineAt <= now) return 'RUN_DEADLINE_EXCEEDED'
  const answer = run.answerSubmission
  const noteRun = answer?.question.report.run
  const note = noteRun?.submission
  if (
    run.workflowVersion !== ANSWER_VERIFICATION_WORKFLOW_VERSION ||
    run.submissionId !== null ||
    !answer ||
    !note ||
    noteRun?.taskId !== run.taskId ||
    note.taskId !== run.taskId ||
    noteRun.kind !== 'NOTE_VERIFICATION' ||
    noteRun.status !== 'SUCCEEDED' ||
    note.repository.userId !== run.task.stage.plan.goal.userId
  )
    return 'EXECUTION_CONTEXT_CHANGED'
  if (!note.repository.enabled) return 'REPOSITORY_BINDING_CHANGED'
  if (
    run.task.stage.plan.status !== 'ACTIVE' ||
    run.task.state !== 'VERIFYING' ||
    run.task.version !== run.expectedTaskVersion ||
    run.task.targetPath !== note.targetPath ||
    run.task.type !== 'MARKDOWN_NOTE'
  )
    return 'TASK_CONTEXT_CHANGED'
  const latestNote = await tx.submission.findFirst({
    where: { taskId: run.taskId },
    orderBy: [{ taskVersion: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true },
  })
  const latestNoteRun = await tx.agentRun.findFirst({
    where: { taskId: run.taskId, kind: 'NOTE_VERIFICATION' },
    orderBy: [{ expectedTaskVersion: 'desc' }, { queuedAt: 'desc' }, { id: 'desc' }],
    select: { id: true },
  })
  if (latestNote?.id !== note.id || latestNoteRun?.id !== noteRun.id) return 'QUESTION_SUPERSEDED'
  return null
}

function material(run: Run, configuration: NoteExecutionConfiguration) {
  const answer = run.answerSubmission!
  const question = answer.question
  const noteRun = question.report.run
  const note = noteRun.submission!
  const evidence = note.evidence
  const draft = followUpQuestionDraftSchema.safeParse(question.body)
  const report = noteVerificationReportBodySchema.safeParse(question.report.body)
  if (
    !evidence ||
    evidence.sourceCommitSha !== note.afterCommitSha ||
    !draft.success ||
    !report.success ||
    report.data.followUp?.status !== 'READY' ||
    !report.data.pendingCriterionIds.includes(draft.data.criterionId) ||
    !run.task.criteria.some((c) => c.id === draft.data.criterionId && c.type === 'FOLLOW_UP_ANSWER')
  )
    throw new NoteEvidenceError('INVALID_EVIDENCE')
  const parsed = parseNoteEvidence({
    ...evidence,
    repositoryId: note.repositoryId,
    path: note.targetPath,
  })
  const expectedSource = {
    taskId: run.taskId,
    submissionId: note.id,
    noteRunId: noteRun.id,
    reportId: question.reportId,
    ...parsed.source,
  }
  if (!isDeepStrictEqual(draft.data.source, expectedSource))
    throw new NoteEvidenceError('INVALID_EVIDENCE')
  return {
    runId: run.id,
    model: configuration.model,
    task: { id: run.task.id, title: run.task.title, description: run.task.description },
    note: parsed,
    question: { id: question.id, ...draft.data },
    answer: { id: answer.id, questionId: question.id, content: answer.content },
  }
}
function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
}
