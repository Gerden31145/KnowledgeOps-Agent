import { isRestorableTaskState, type AgentRunState, type TaskState } from '@knowledgeops/contracts'
import type { Prisma } from '@knowledgeops/database'

export type VerificationRunResult = {
  runId: string
  status: AgentRunState | 'IGNORED' | 'PENDING'
  reportId: string | null
}
type Run = {
  id: string
  taskId: string
  status: AgentRunState
  expectedTaskVersion: number | null
  taskStateBeforeRun: TaskState
}

// 调用者已持有 User → Task → Run 锁。只恢复本次运行占据的 Task 版本。
export async function terminateVerificationRun(
  tx: Prisma.TransactionClient,
  run: Run,
  code: string,
  now: Date,
): Promise<VerificationRunResult> {
  const status =
    code === 'RUN_CANCEL_REQUESTED'
      ? 'CANCELLED'
      : code === 'RUN_DEADLINE_EXCEEDED'
        ? 'TIMED_OUT'
        : 'FAILED'
  if (run.status === 'QUEUED') {
    await tx.agentRun.update({ where: { id: run.id }, data: { status: 'RUNNING', startedAt: now } })
  }
  await tx.agentRun.update({
    where: { id: run.id },
    data: {
      status,
      errorCode: code,
      finishedAt: now,
      version: { increment: 1 },
    },
  })
  if (run.expectedTaskVersion !== null && isRestorableTaskState(run.taskStateBeforeRun)) {
    await tx.task.updateMany({
      where: { id: run.taskId, state: 'VERIFYING', version: run.expectedTaskVersion },
      data: { state: run.taskStateBeforeRun, version: { increment: 1 } },
    })
  }
  return { runId: run.id, status, reportId: null }
}
export function verificationRunSnapshot(
  run: Pick<Run, 'id' | 'status'> & { report: { id: string } | null },
): VerificationRunResult {
  return { runId: run.id, status: run.status, reportId: run.report?.id ?? null }
}
export function ignoredVerificationRun(runId: string): VerificationRunResult {
  return { runId, status: 'IGNORED', reportId: null }
}
