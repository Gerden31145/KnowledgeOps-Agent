import { ConflictException, NotFoundException } from '@nestjs/common'
import {
  isAgentRunTerminalState,
  cancelVerificationRunResponseSchema,
  type CancelVerificationRunInput,
} from '@knowledgeops/contracts'
import { Prisma, type DatabaseClient } from '@knowledgeops/database'

const missing = () =>
  new NotFoundException({ code: 'RESOURCE_NOT_FOUND', message: '验收运行不存在。' })

export class CancelVerificationRunService {
  constructor(private readonly database: DatabaseClient) {}

  async cancel(userId: string, runId: string, input: CancelVerificationRunInput) {
    return this.database.$transaction(async (tx) => {
      // 与 Worker Finalizer 使用相同的 User → Task → Run 锁顺序。
      await tx.$queryRaw(Prisma.sql`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`)
      const where: Prisma.AgentRunWhereInput = {
        id: runId,
        kind: { in: ['NOTE_VERIFICATION', 'ANSWER_VERIFICATION'] },
        task: { stage: { plan: { goal: { userId } } } },
      }
      const owner = await tx.agentRun.findFirst({ where, select: { taskId: true } })
      if (!owner) throw missing()
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM tasks WHERE id = ${owner.taskId}::uuid FOR UPDATE`,
      )
      await tx.$queryRaw(Prisma.sql`SELECT id FROM agent_runs WHERE id = ${runId}::uuid FOR UPDATE`)
      const run = await tx.agentRun.findFirst({
        where: { ...where, taskId: owner.taskId },
        select: { id: true, taskId: true, status: true, version: true },
      })
      if (!run) throw missing()

      // 响应丢失后的重发及终态竞争都只回当前快照，不再次加版本或覆盖报告。
      if (run.status === 'CANCEL_REQUESTED' || isAgentRunTerminalState(run.status))
        return cancelVerificationRunResponseSchema.parse({
          runId: run.id,
          taskId: run.taskId,
          status: run.status,
          version: run.version,
        })
      if (run.version !== input.expectedRunVersion)
        throw new ConflictException({ code: 'CONFLICT', message: '运行已变化，请刷新后再取消。' })

      const changed = await tx.agentRun.update({
        where: { id: runId, version: run.version },
        data: { status: 'CANCEL_REQUESTED', version: { increment: 1 } },
        select: { taskId: true, status: true, version: true },
      })
      // 不删除 BullMQ Job，不提前恢复 Task；Worker 的领取/落库或恢复扫描完成收束。
      return cancelVerificationRunResponseSchema.parse({ runId, ...changed })
    })
  }
}
