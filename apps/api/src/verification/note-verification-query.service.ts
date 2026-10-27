import { noteVerificationRunResponseSchema } from '@knowledgeops/contracts'
import type { DatabaseClient } from '@knowledgeops/database'
import { NotFoundException } from '@nestjs/common'

export class NoteVerificationQueryService {
  constructor(private readonly database: DatabaseClient) {}

  async getRun(runId: string, userId: string) {
    const run = await this.database.agentRun.findFirst({
      where: {
        id: runId,
        kind: 'NOTE_VERIFICATION',
        task: { stage: { plan: { goal: { userId } } } },
      },
      include: { report: true },
    })
    if (!run)
      throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND', message: '验收运行不存在。' })
    // 仅返回所属用户的业务快照；不暴露模型凭据、内部配置或完整账本。
    return noteVerificationRunResponseSchema.parse({
      runId: run.id,
      taskId: run.taskId,
      submissionId: run.submissionId,
      status: run.status,
      version: run.version,
      queuedAt: run.queuedAt.toISOString(),
      startedAt: run.startedAt?.toISOString() ?? null,
      finishedAt: run.finishedAt?.toISOString() ?? null,
      errorCode: run.errorCode,
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
