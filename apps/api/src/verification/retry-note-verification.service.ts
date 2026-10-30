import { randomUUID } from 'node:crypto'
import { ConflictException, NotFoundException } from '@nestjs/common'
import {
  isRestorableTaskState,
  NOTE_VERIFICATION_OUTBOX_SCHEMA_VERSION,
  NOTE_VERIFICATION_WORKFLOW_VERSION,
  noteVerificationRequestedEventPayloadSchema,
  retryNoteVerificationResponseSchema,
  type RetryNoteVerificationInput,
} from '@knowledgeops/contracts'
import { Prisma, type DatabaseClient } from '@knowledgeops/database'

const conflict = () =>
  new ConflictException({
    code: 'CONFLICT',
    message: '运行、任务或仓库绑定已变化，请刷新后确认当前笔记。',
  })

export class RetryNoteVerificationService {
  constructor(private readonly database: DatabaseClient) {}

  async retry(userId: string, runId: string, input: RetryNoteVerificationInput) {
    return this.database.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`)
      const where: Prisma.AgentRunWhereInput = {
        id: runId,
        kind: 'NOTE_VERIFICATION',
        task: { stage: { plan: { goal: { userId } } } },
      }
      const owner = await tx.agentRun.findFirst({ where, select: { taskId: true } })
      if (!owner)
        throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND', message: '笔记验收运行不存在。' })
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM tasks WHERE id = ${owner.taskId}::uuid FOR UPDATE`,
      )
      await tx.$queryRaw(Prisma.sql`SELECT id FROM agent_runs WHERE id = ${runId}::uuid FOR UPDATE`)
      const run = await tx.agentRun.findFirstOrThrow({
        where,
        include: {
          task: { include: { stage: { include: { plan: true } } } },
          submission: {
            include: { repository: true, evidence: { select: { sourceCommitSha: true } } },
          },
        },
      })
      // 同一旧 Run 只创建一个直接后继；响应丢失、刷新或重复点击都找回它。
      // 若后继也失败，用户必须在后继 Run 上发起下一次重试。
      const existing = await tx.agentRun.findFirst({
        where: { retryOfRunId: runId, taskId: run.taskId, kind: 'NOTE_VERIFICATION' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
      if (existing)
        return retryNoteVerificationResponseSchema.parse({
          status: 'ACCEPTED',
          runId: existing.id,
          retryOfRunId: runId,
          taskId: existing.taskId,
          taskVersion: existing.expectedTaskVersion,
        })

      const task = run.task,
        note = run.submission
      if (
        !['FAILED', 'TIMED_OUT', 'CANCELLED'].includes(run.status) ||
        run.version !== input.expectedRunVersion ||
        run.expectedTaskVersion === null ||
        run.workflowVersion !== NOTE_VERIFICATION_WORKFLOW_VERSION ||
        run.answerSubmissionId !== null ||
        task.version !== input.expectedTaskVersion ||
        task.version !== run.expectedTaskVersion + 1 ||
        task.state !== run.taskStateBeforeRun ||
        !isRestorableTaskState(task.state) ||
        task.stage.plan.status !== 'ACTIVE' ||
        task.type !== 'MARKDOWN_NOTE' ||
        !note ||
        note.taskId !== task.id ||
        note.targetPath !== task.targetPath ||
        note.workflowVersion !== NOTE_VERIFICATION_WORKFLOW_VERSION ||
        !note.repository.enabled ||
        note.repository.userId !== userId ||
        !note.evidence ||
        note.evidence.sourceCommitSha !== note.afterCommitSha
      )
        throw conflict()

      const latestNote = await tx.submission.findFirst({
        where: { taskId: task.id },
        orderBy: [{ taskVersion: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      })
      const latestRun = await tx.agentRun.findFirst({
        where: { taskId: task.id, kind: 'NOTE_VERIFICATION' },
        orderBy: [{ expectedTaskVersion: 'desc' }, { queuedAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      })
      const busy = await tx.agentRun.findFirst({
        where: { taskId: task.id, status: { in: ['QUEUED', 'RUNNING', 'CANCEL_REQUESTED'] } },
        select: { id: true },
      })
      if (latestNote?.id !== note.id || latestRun?.id !== run.id || busy) throw conflict()

      const newRunId = randomUUID(),
        taskVersion = task.version + 1
      await tx.task.update({
        where: { id: task.id, version: task.version },
        data: { state: 'VERIFYING', version: taskVersion },
      })
      await tx.agentRun.create({
        data: {
          id: newRunId,
          taskId: task.id,
          kind: 'NOTE_VERIFICATION',
          submissionId: note.id,
          retryOfRunId: run.id,
          taskStateBeforeRun: task.state,
          expectedTaskVersion: taskVersion,
          workflowVersion: NOTE_VERIFICATION_WORKFLOW_VERSION,
        },
      })
      await tx.outboxEvent.create({
        data: {
          type: 'NOTE_VERIFICATION_REQUESTED',
          aggregateId: newRunId,
          schemaVersion: NOTE_VERIFICATION_OUTBOX_SCHEMA_VERSION,
          // 既有唯一约束为同一旧 Run 的创建提供最终防重；失败则整个事务回滚。
          deduplicationKey: `note-verification-retry-${run.id}`,
          payload: noteVerificationRequestedEventPayloadSchema.parse({
            runId: newRunId,
            submissionId: note.id,
          }),
        },
      })
      return retryNoteVerificationResponseSchema.parse({
        status: 'ACCEPTED',
        runId: newRunId,
        retryOfRunId: run.id,
        taskId: task.id,
        taskVersion,
      })
    })
  }
}
