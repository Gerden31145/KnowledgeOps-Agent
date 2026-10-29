import { Prisma } from '@knowledgeops/database'

export class InvalidFollowUpCriterionError extends Error {
  constructor() {
    super('INVALID_FOLLOW_UP_CRITERION')
    this.name = 'InvalidFollowUpCriterionError'
  }
}

// 由计划创建事务，或尚未冻结执行配置的首次领取事务调用。
// Task 行锁让并发补齐复用同一条标准；不修改已有标准或历史报告。
export async function ensureRequiredFollowUpCriterion(
  tx: Prisma.TransactionClient,
  taskId: string,
): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM tasks WHERE id = ${taskId}::uuid FOR UPDATE`)
  const criteria = await tx.acceptanceCriterion.findMany({
    where: { taskId },
    orderBy: { position: 'asc' },
    select: { type: true, required: true, position: true },
  })
  const followUp = criteria.filter(({ type }) => type === 'FOLLOW_UP_ANSWER')
  if (
    followUp.length > 1 ||
    (followUp.length === 1 && !followUp[0]!.required) ||
    criteria.length === followUp.length
  )
    throw new InvalidFollowUpCriterionError()
  if (followUp.length === 1) return

  await tx.acceptanceCriterion.create({
    data: {
      taskId,
      type: 'FOLLOW_UP_ANSWER',
      required: true,
      description: '回答基于本次笔记生成的理解追问，并通过回答验收。',
      position: (criteria.at(-1)?.position ?? -1) + 1,
    },
  })
}
