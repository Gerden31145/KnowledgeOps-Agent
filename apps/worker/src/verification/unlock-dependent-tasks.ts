import type { Prisma } from '@knowledgeops/database'

// 调用方已持有用户行锁，并在同一事务把当前 Task 写为 PASSED。
// 用户开始任务和其他 Finalizer 也持有此锁，避免并发完成前置任务时漏掉解锁。
export async function unlockDependentTasks(
  tx: Prisma.TransactionClient,
  passedTaskId: string,
  planId: string,
): Promise<void> {
  await tx.task.updateMany({
    where: {
      state: 'BLOCKED',
      stage: { planId, plan: { status: 'ACTIVE' } },
      prerequisites: {
        // 只检查直接依赖本次已通过任务的后续任务，不按 position 猜测“下一项”。
        some: { prerequisiteTaskId: passedTaskId },
        // 所有前置都须通过且属于同一计划；异常的跨计划依赖不能带来解锁。
        every: { prerequisiteTask: { state: 'PASSED', stage: { planId } } },
      },
    },
    // BLOCKED 条件使重复检查不会重复递增版本，也不会重置已经开始/通过的任务。
    data: { state: 'READY', version: { increment: 1 } },
  })
}
