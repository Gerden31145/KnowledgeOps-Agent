import { createHash } from 'node:crypto'
import {
  noteVerificationRunResponseSchema,
  followUpQuestionDraftSchema,
  noteRunEvidenceResponseSchema,
} from '@knowledgeops/contracts'
import type { DatabaseClient } from '@knowledgeops/database'
import { NotFoundException, InternalServerErrorException } from '@nestjs/common'

export class NoteVerificationQueryService {
  constructor(private readonly database: DatabaseClient) {}

  async getEvidence(runId: string, userId: string) {
    const run = await this.database.agentRun.findFirst({
      where: {
        id: runId,
        kind: 'NOTE_VERIFICATION',
        task: { stage: { plan: { goal: { userId } } } },
      },
      select: {
        id: true,
        taskId: true,
        submission: { include: { evidence: true, repository: { select: { userId: true } } } },
      },
    })
    const submission = run?.submission
    const evidence = submission?.evidence
    // 不存在与越权统一返回 404；历史证据不依赖当前绑定是否仍启用。
    if (
      !run ||
      !submission ||
      !evidence ||
      submission.taskId !== run.taskId ||
      submission.repository.userId !== userId
    )
      throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND', message: '无法查看此运行的证据。' })

    const result = noteRunEvidenceResponseSchema.safeParse({
      runId: run.id,
      taskId: run.taskId,
      submissionId: submission.id,
      repositoryId: submission.repositoryId,
      path: submission.targetPath,
      beforeCommitSha: submission.beforeCommitSha,
      afterCommitSha: submission.afterCommitSha,
      sourceCommitSha: evidence.sourceCommitSha,
      contentHash: evidence.contentHash,
      content: evidence.content,
      lineCount: evidence.lineCount,
      mode: evidence.mode,
      change: evidence.change,
      previousPath: evidence.previousPath,
      diff: evidence.diff,
    })
    const expectedSource =
      evidence.change === 'removed' ? submission.beforeCommitSha : submission.afterCommitSha
    const validMode =
      evidence.mode === 'SNAPSHOT'
        ? evidence.change === null && evidence.diff === null && evidence.previousPath === null
        : evidence.change !== null
    const bytes = Buffer.from(evidence.content, 'utf8')
    const lineCount =
      evidence.content === ''
        ? 0
        : evidence.content.replace(/(?:\r\n|\n|\r)$/, '').split(/\r\n|\n|\r/).length
    if (
      !result.success ||
      !validMode ||
      evidence.sourceCommitSha !== expectedSource ||
      lineCount !== evidence.lineCount ||
      bytes.length > 1_000_000 ||
      evidence.content.includes('\0') ||
      createHash('sha256').update(bytes).digest('hex') !== evidence.contentHash
    ) {
      throw new InternalServerErrorException({
        code: 'INTERNAL_ERROR',
        message: '暂时无法读取固定证据。',
      })
    }
    return result.data
  }

  async getRun(runId: string, userId: string) {
    const run = await this.database.agentRun.findFirst({
      where: {
        id: runId,
        kind: 'NOTE_VERIFICATION',
        task: { stage: { plan: { goal: { userId } } } },
      },
      include: {
        retries: {
          where: { kind: 'NOTE_VERIFICATION' },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: 1,
          select: { id: true },
        },
        report: {
          include: {
            followUpQuestion: {
              include: {
                answers: {
                  orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                  take: 20,
                  select: { id: true, createdAt: true },
                },
              },
            },
          },
        },
      },
    })
    if (!run)
      throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND', message: '验收运行不存在。' })
    const savedQuestion = run.report?.followUpQuestion
    const question = savedQuestion ? followUpQuestionDraftSchema.parse(savedQuestion.body) : null
    // 仅返回所属用户的业务快照；不暴露模型凭据、内部配置或完整账本。
    return noteVerificationRunResponseSchema.parse({
      runId: run.id,
      taskId: run.taskId,
      submissionId: run.submissionId,
      retryOfRunId: run.retryOfRunId,
      retryRunId: run.retries[0]?.id ?? null,
      status: run.status,
      version: run.version,
      queuedAt: run.queuedAt.toISOString(),
      startedAt: run.startedAt?.toISOString() ?? null,
      finishedAt: run.finishedAt?.toISOString() ?? null,
      errorCode: run.errorCode,
      followUpQuestion:
        savedQuestion && question
          ? {
              id: savedQuestion.id,
              criterionId: question.criterionId,
              question: question.question,
              citations: question.citations,
              answers: savedQuestion.answers.map((answer) => ({
                id: answer.id,
                createdAt: answer.createdAt.toISOString(),
              })),
            }
          : null,
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
