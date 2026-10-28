import { randomUUID } from 'node:crypto'
import { ConflictException, NotFoundException } from '@nestjs/common'
import {
  ANSWER_VERIFICATION_OUTBOX_SCHEMA_VERSION,
  ANSWER_VERIFICATION_WORKFLOW_VERSION,
  answerVerificationRequestedEventPayloadSchema,
  followUpAnswerResponseSchema,
  followUpQuestionDraftSchema,
  noteVerificationReportBodySchema,
  type FollowUpAnswerAcceptedResponse,
  type SubmitFollowUpAnswerInput,
} from '@knowledgeops/contracts'
import { Prisma, type DatabaseClient } from '@knowledgeops/database'

const missing = () =>
  new NotFoundException({ code: 'RESOURCE_NOT_FOUND', message: '追问或回答不存在。' })
const conflict = () =>
  new ConflictException({ code: 'CONFLICT', message: '追问、任务或提交内容已变化，请刷新后确认。' })

export class FollowUpAnswerService {
  constructor(private readonly database: DatabaseClient) {}

  async submit(
    userId: string,
    questionId: string,
    input: SubmitFollowUpAnswerInput,
  ): Promise<FollowUpAnswerAcceptedResponse> {
    return this.database.$transaction(async (tx) => {
      // 与绑定、取证和报告 Finalizer 共用 User → Task 锁顺序。事务中没有模型/Redis 请求。
      await tx.$queryRaw(Prisma.sql`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`)
      const owner = await tx.followUpQuestion.findFirst({
        where: {
          id: questionId,
          report: { run: { task: { stage: { plan: { goal: { userId } } } } } },
        },
        select: { report: { select: { run: { select: { taskId: true } } } } },
      })
      if (!owner) throw missing()
      const taskId = owner.report.run.taskId
      await tx.$queryRaw(Prisma.sql`SELECT id FROM tasks WHERE id = ${taskId}::uuid FOR UPDATE`)

      // 响应丢失后重放原请求，即使 Run 已结束/任务已变化也只回原受理凭据，不创建新任务。
      const existing = await tx.answerSubmission.findUnique({
        where: { questionId_requestId: { questionId, requestId: input.requestId } },
        include: { runs: { where: { retryOfRunId: null } } },
      })
      if (existing) {
        const run = existing.runs[0]
        if (
          existing.content !== input.answer ||
          existing.expectedTaskVersion !== input.expectedTaskVersion ||
          !run
        )
          throw conflict()
        return {
          status: 'ACCEPTED',
          answerSubmissionId: existing.id,
          runId: run.id,
          taskId,
          taskVersion: existing.expectedTaskVersion + 1,
        }
      }

      const question = await tx.followUpQuestion.findUniqueOrThrow({
        where: { id: questionId },
        include: {
          report: {
            include: {
              run: {
                include: {
                  task: { include: { criteria: true, stage: { include: { plan: true } } } },
                  submission: { include: { repository: true, evidence: true } },
                },
              },
            },
          },
        },
      })
      const noteRun = question.report.run
      const task = noteRun.task
      const note = noteRun.submission
      const draft = followUpQuestionDraftSchema.safeParse(question.body)
      const report = noteVerificationReportBodySchema.safeParse(question.report.body)
      if (
        noteRun.kind !== 'NOTE_VERIFICATION' ||
        noteRun.status !== 'SUCCEEDED' ||
        noteRun.expectedTaskVersion === null ||
        task.version < noteRun.expectedTaskVersion ||
        !note ||
        !note.evidence ||
        !note.repository.enabled ||
        note.repository.userId !== userId ||
        note.taskId !== task.id ||
        task.type !== 'MARKDOWN_NOTE' ||
        task.version !== input.expectedTaskVersion ||
        task.targetPath !== note.targetPath ||
        task.stage.plan.status !== 'ACTIVE' ||
        // R11 尚未汇总状态：兼容已完成笔记 Run、版本未变化的 VERIFYING；运行中另行拒绝。
        !(
          task.state === 'NEEDS_EVIDENCE' ||
          (task.state === 'VERIFYING' && task.version === noteRun.expectedTaskVersion)
        ) ||
        !draft.success ||
        !report.success ||
        report.data.followUp?.status !== 'READY'
      )
        throw conflict()
      const expectedSource = {
        taskId,
        submissionId: note.id,
        noteRunId: noteRun.id,
        reportId: question.reportId,
        repositoryId: note.repositoryId,
        commitSha: note.afterCommitSha,
        path: note.targetPath,
        contentHash: note.evidence.contentHash,
      }
      if (
        Object.entries(expectedSource).some(
          ([key, value]) => draft.data.source[key as keyof typeof expectedSource] !== value,
        ) ||
        !task.criteria.some(
          (c) => c.id === draft.data.criterionId && c.type === 'FOLLOW_UP_ANSWER',
        ) ||
        !report.data.pendingCriterionIds.includes(draft.data.criterionId)
      )
        throw conflict()

      // 最新笔记/重验即使失败，也不能让旧追问重新取得资格。使用业务版本而非 Commit 字符串排序。
      const latestNote = await tx.submission.findFirst({
        where: { taskId },
        orderBy: [{ taskVersion: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      })
      const latestNoteRun = await tx.agentRun.findFirst({
        where: { taskId, kind: 'NOTE_VERIFICATION' },
        orderBy: [{ expectedTaskVersion: 'desc' }, { queuedAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      })
      const busy = await tx.agentRun.findFirst({
        where: { taskId, status: { in: ['QUEUED', 'RUNNING', 'CANCEL_REQUESTED'] } },
        select: { id: true },
      })
      if (latestNote?.id !== note.id || latestNoteRun?.id !== noteRun.id || busy) throw conflict()

      const answer = await tx.answerSubmission.create({
        data: {
          questionId,
          requestId: input.requestId,
          expectedTaskVersion: input.expectedTaskVersion,
          content: input.answer,
        },
      })
      const taskVersion = task.version + 1
      await tx.task.update({
        where: { id: taskId },
        data: { state: 'VERIFYING', version: taskVersion },
      })
      const runId = randomUUID()
      await tx.agentRun.create({
        data: {
          id: runId,
          taskId,
          answerSubmissionId: answer.id,
          expectedTaskVersion: taskVersion,
          kind: 'ANSWER_VERIFICATION',
          taskStateBeforeRun: 'NEEDS_EVIDENCE',
          workflowVersion: ANSWER_VERIFICATION_WORKFLOW_VERSION,
        },
      })
      await tx.outboxEvent.create({
        data: {
          type: 'ANSWER_VERIFICATION_REQUESTED',
          aggregateId: runId,
          schemaVersion: ANSWER_VERIFICATION_OUTBOX_SCHEMA_VERSION,
          deduplicationKey: `answer-verification-requested-${runId}`,
          payload: answerVerificationRequestedEventPayloadSchema.parse({
            runId,
            answerSubmissionId: answer.id,
          }),
        },
      })
      return { status: 'ACCEPTED', answerSubmissionId: answer.id, runId, taskId, taskVersion }
    })
  }

  async get(userId: string, answerSubmissionId: string) {
    const answer = await this.database.answerSubmission.findFirst({
      where: {
        id: answerSubmissionId,
        question: { report: { run: { task: { stage: { plan: { goal: { userId } } } } } } },
      },
      include: {
        runs: {
          where: { retryOfRunId: null },
          select: {
            id: true,
            taskId: true,
            status: true,
            version: true,
            errorCode: true,
            queuedAt: true,
            startedAt: true,
            finishedAt: true,
            report: true,
          },
        },
      },
    })
    const run = answer?.runs[0]
    if (!answer || !run) throw missing()
    // 历史回答仅所属用户可读；不暴露原题评分要点、内部配置或凭据。
    return followUpAnswerResponseSchema.parse({
      answerSubmissionId: answer.id,
      questionId: answer.questionId,
      answer: answer.content,
      createdAt: answer.createdAt.toISOString(),
      run: {
        runId: run.id,
        taskId: run.taskId,
        status: run.status,
        version: run.version,
        errorCode: run.errorCode,
        queuedAt: run.queuedAt.toISOString(),
        startedAt: run.startedAt?.toISOString() ?? null,
        finishedAt: run.finishedAt?.toISOString() ?? null,
      },
      report: run.report
        ? {
            id: run.report.id,
            createdAt: run.report.createdAt.toISOString(),
            body: run.report.body,
          }
        : null,
    })
  }
}
