import { randomUUID } from 'node:crypto'
import { ConflictException, NotFoundException } from '@nestjs/common'
import {
  ANSWER_VERIFICATION_OUTBOX_SCHEMA_VERSION,
  ANSWER_VERIFICATION_WORKFLOW_VERSION,
  answerVerificationRequestedEventPayloadSchema,
  followUpQuestionDraftSchema,
  noteVerificationReportBodySchema,
  retryAnswerVerificationResponseSchema,
  type RetryAnswerVerificationInput,
} from '@knowledgeops/contracts'
import { Prisma, type DatabaseClient } from '@knowledgeops/database'

const conflict = () =>
  new ConflictException({
    code: 'CONFLICT',
    message: '回答、追问或任务已变化，请刷新后确认最新运行。',
  })

export class RetryAnswerVerificationService {
  constructor(private readonly database: DatabaseClient) {}

  async retry(
    userId: string,
    answerSubmissionId: string,
    runId: string,
    input: RetryAnswerVerificationInput,
  ) {
    return this.database.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`)
      const where: Prisma.AgentRunWhereInput = {
        id: runId,
        answerSubmissionId,
        kind: 'ANSWER_VERIFICATION',
        task: { stage: { plan: { goal: { userId } } } },
      }
      const owner = await tx.agentRun.findFirst({ where, select: { taskId: true } })
      if (!owner)
        throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND', message: '回答验收运行不存在。' })
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM tasks WHERE id = ${owner.taskId}::uuid FOR UPDATE`,
      )
      await tx.$queryRaw(Prisma.sql`SELECT id FROM agent_runs WHERE id = ${runId}::uuid FOR UPDATE`)
      const run = await tx.agentRun.findFirstOrThrow({
        where,
        include: {
          task: { include: { criteria: true, stage: { include: { plan: true } } } },
          answerSubmission: {
            include: {
              question: {
                include: {
                  report: {
                    include: {
                      run: {
                        include: { submission: { include: { repository: true, evidence: true } } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      })
      // 原运行就是本次命令身份。先找后继，响应丢失后即使任务已推进也能返回原回执。
      const existing = await tx.agentRun.findFirst({
        where: {
          retryOfRunId: run.id,
          kind: 'ANSWER_VERIFICATION',
          taskId: run.taskId,
          answerSubmissionId,
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
      const receipt = (child: { id: string; expectedTaskVersion: number | null }) =>
        retryAnswerVerificationResponseSchema.parse({
          status: 'ACCEPTED',
          runId: child.id,
          retryOfRunId: run.id,
          taskId: run.taskId,
          taskVersion: child.expectedTaskVersion,
          answerSubmissionId,
        })
      if (existing) return receipt(existing)

      const task = run.task,
        answer = run.answerSubmission
      const question = answer?.question,
        noteRun = question?.report.run,
        note = noteRun?.submission
      if (
        !['FAILED', 'TIMED_OUT', 'CANCELLED'].includes(run.status) ||
        run.version !== input.expectedRunVersion ||
        run.expectedTaskVersion === null ||
        run.workflowVersion !== ANSWER_VERIFICATION_WORKFLOW_VERSION ||
        run.submissionId !== null ||
        task.version !== input.expectedTaskVersion ||
        task.version !== run.expectedTaskVersion + 1 ||
        task.state !== 'NEEDS_EVIDENCE' ||
        run.taskStateBeforeRun !== 'NEEDS_EVIDENCE' ||
        task.stage.plan.status !== 'ACTIVE' ||
        task.type !== 'MARKDOWN_NOTE' ||
        !answer ||
        !question ||
        !note ||
        noteRun?.kind !== 'NOTE_VERIFICATION' ||
        noteRun.status !== 'SUCCEEDED' ||
        noteRun.taskId !== task.id ||
        note.taskId !== task.id ||
        note.targetPath !== task.targetPath ||
        !note.repository.enabled ||
        note.repository.userId !== userId ||
        !note.evidence ||
        note.evidence.sourceCommitSha !== note.afterCommitSha
      )
        throw conflict()

      const draft = followUpQuestionDraftSchema.safeParse(question.body)
      const report = noteVerificationReportBodySchema.safeParse(question.report.body)
      if (
        !draft.success ||
        !report.success ||
        report.data.followUp?.status !== 'READY' ||
        !report.data.pendingCriterionIds.includes(draft.data.criterionId) ||
        !task.criteria.some((c) => c.id === draft.data.criterionId && c.type === 'FOLLOW_UP_ANSWER')
      )
        throw conflict()
      const source = {
        taskId: task.id,
        submissionId: note.id,
        noteRunId: noteRun.id,
        reportId: question.reportId,
        repositoryId: note.repositoryId,
        commitSha: note.afterCommitSha,
        path: note.targetPath,
        contentHash: note.evidence.contentHash,
      }
      if (
        Object.entries(source).some(
          ([key, value]) => draft.data.source[key as keyof typeof source] !== value,
        )
      )
        throw conflict()

      // 不能恢复旧题/旧答案的资格；以业务版本排序，失败的新回答也会取代旧回答。
      const latestNote = await tx.submission.findFirst({
        where: { taskId: task.id },
        orderBy: [{ taskVersion: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      })
      const latestNoteRun = await tx.agentRun.findFirst({
        where: { taskId: task.id, kind: 'NOTE_VERIFICATION' },
        orderBy: [{ expectedTaskVersion: 'desc' }, { queuedAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      })
      const latestAnswerRun = await tx.agentRun.findFirst({
        where: { taskId: task.id, kind: 'ANSWER_VERIFICATION' },
        orderBy: [{ expectedTaskVersion: 'desc' }, { queuedAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      })
      const busy = await tx.agentRun.findFirst({
        where: { taskId: task.id, status: { in: ['QUEUED', 'RUNNING', 'CANCEL_REQUESTED'] } },
        select: { id: true },
      })
      if (
        latestNote?.id !== note.id ||
        latestNoteRun?.id !== noteRun.id ||
        latestAnswerRun?.id !== run.id ||
        busy
      )
        throw conflict()

      const taskVersion = task.version + 1,
        newRunId = randomUUID()
      await tx.task.update({
        where: { id: task.id, version: task.version },
        data: { state: 'VERIFYING', version: taskVersion },
      })
      await tx.agentRun.create({
        data: {
          id: newRunId,
          taskId: task.id,
          kind: 'ANSWER_VERIFICATION',
          answerSubmissionId,
          retryOfRunId: run.id,
          expectedTaskVersion: taskVersion,
          taskStateBeforeRun: 'NEEDS_EVIDENCE',
          workflowVersion: ANSWER_VERIFICATION_WORKFLOW_VERSION,
        },
      })
      await tx.outboxEvent.create({
        data: {
          type: 'ANSWER_VERIFICATION_REQUESTED',
          aggregateId: newRunId,
          schemaVersion: ANSWER_VERIFICATION_OUTBOX_SCHEMA_VERSION,
          deduplicationKey: `answer-verification-retry-${run.id}`,
          payload: answerVerificationRequestedEventPayloadSchema.parse({
            runId: newRunId,
            answerSubmissionId,
          }),
        },
      })
      return receipt({ id: newRunId, expectedTaskVersion: taskVersion })
    })
  }
}
