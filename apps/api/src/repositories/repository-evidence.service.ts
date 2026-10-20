import { NotFoundException } from '@nestjs/common'
import {
  CURRENT_TASK_STATES,
  GITHUB_PUSH_RECEIVED_SCHEMA_VERSION,
  REPOSITORY_EVIDENCE_LIMIT,
  githubPushPayloadSchema,
  githubPushReceivedEventPayloadSchema,
  githubEvidenceRetryEventSchema,
  retryableEvidenceFailureSchema,
  type RepositoryEvidenceResponse,
} from '@knowledgeops/contracts'
import type { Prisma } from '@knowledgeops/database'
import type { DatabaseService } from '../database/database.service.js'

type Delivery = Prisma.WebhookDeliveryGetPayload<object>
type VisibleState = Pick<RepositoryEvidenceResponse['deliveries'][number], 'status' | 'message'>

const intakeIgnoreReasons: Readonly<Record<string, string>> = {
  NO_CURRENT_TASK:
    '接收这次 Push 时没有正在进行的笔记任务，未开始取证。请先开始任务，再修改目标文件并提交新的 Push。',
  AMBIGUOUS_CURRENT_TASK:
    '接收时存在多个当前任务，无法安全确定本次提交属于谁，未开始取证。请先检查任务状态。',
  INVALID_TARGET_PATH:
    '接收时当前任务没有有效的 Markdown 目标路径，未开始取证。请检查任务目标路径。',
  BRANCH_NOT_TRACKED: '本次 Push 不是当前绑定的目标分支，未开始取证。',
  REF_UNSUPPORTED: '本次通知不是分支 Push（例如 Tag），未开始取证。',
  BRANCH_DELETED: '本次通知表示分支已删除，未开始取证。',
}

// 白名单文案；不把数据库里的任意错误字符串、上游响应或 Outbox.lastError 发给浏览器。
const reasons: Readonly<Record<string, string>> = {
  ...intakeIgnoreReasons,
  GITHUB_UNAVAILABLE: 'GitHub 暂时不可用。',
  GITHUB_AUTH_REQUIRED: 'GitHub 授权不可用，请检查 App 安装和仓库读取权限。',
  SOURCE_UNAVAILABLE: '提交或文件不可读取，请检查仓库访问权限。',
  RESYNC_REQUIRED: '比较基准或固定提交的正文不可读取，可尝试按原提交的全文快照重新同步。',
  LIMIT_EXCEEDED: '提交或文件超过当前取证大小限制。',
  INVALID_GITHUB_RESPONSE: 'GitHub 响应不符合取证要求，未使用不完整证据。',
  INCOMPLETE_DIFF: '提交差异不完整，未继续验收。',
  UNSUPPORTED_FILE: '目标文件格式不受支持。',
  UNSUPPORTED_COMPARISON: '当前提交历史无法完成比较。',
  INVALID_INPUT: '取证输入不合法。',
  INVALID_INTAKE: '接收记录不符合处理要求。',
  INVALID_EVIDENCE: '证据未通过完整性校验。',
  TASK_STATE_INCONSISTENT: '任务状态不符合处理要求。',
  TASK_CHANGED: '原任务、路径或版本已变化，本次通知不再用于验收。',
  BINDING_CHANGED: '原仓库绑定已变化，本次通知不再用于验收。',
  NO_MARKDOWN_CHANGE: '没有可用于验收的 Markdown 变更。',
  TARGET_NOT_CHANGED: '本次提交没有修改原任务的目标文件。',
  TARGET_RENAMED: '目标文件已改名，未自动切换任务目标。',
}

function safeReason(code: string | null): string | undefined {
  return code && Object.hasOwn(reasons, code) ? reasons[code] : undefined
}

export class RepositoryEvidenceService {
  constructor(private readonly database: DatabaseService) {}

  async list(userId: string, repositoryId: string): Promise<RepositoryEvidenceResponse> {
    // 同一数据库快照读取绑定、原通知上下文和处理结果；不锁行、不调用 GitHub、不触发任务。
    return this.database.client.$transaction(
      async (tx) => {
        const repository = await tx.repository.findFirst({
          where: { id: repositoryId, userId, enabled: true },
          include: { user: { select: { repositoryVersion: true } } },
        })
        if (!repository)
          throw new NotFoundException({
            code: 'RESOURCE_NOT_FOUND',
            message: '找不到当前用户的活动仓库绑定，请刷新绑定状态。',
          })

        // 接收时已冻结本项目绑定；不能按 GitHub 仓库号把旧通知交给后来重绑的用户。
        const deliveries = await tx.webhookDelivery.findMany({
          where: { receivedRepositoryId: repository.id, eventType: 'push' },
          orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
          take: REPOSITORY_EVIDENCE_LIMIT,
          include: { submission: { select: { evidence: { select: { mode: true } } } } },
        })
        // 有取证待办才读取原任务上下文；接收时直接忽略的通知没有 Outbox。
        const events = await tx.outboxEvent.findMany({
          where: {
            type: 'GITHUB_PUSH_RECEIVED',
            aggregateId: { in: deliveries.map((delivery) => delivery.id) },
          },
          select: { aggregateId: true, payload: true, schemaVersion: true, deadLetteredAt: true },
        })
        const eventById = new Map(events.map((event) => [event.aggregateId, event]))
        // 按原任务批量检查按钮资格，不为失败通知重新选择当前任务；POST 仍须锁行复核。
        const tasks = await tx.task.findMany({
          where: {
            id: {
              in: events.flatMap((event) => {
                const parsed = githubPushReceivedEventPayloadSchema.safeParse(event.payload)
                return parsed.success ? [parsed.data.task.taskId] : []
              }),
            },
            type: 'MARKDOWN_NOTE',
            state: { in: [...CURRENT_TASK_STATES] },
            stage: { plan: { status: 'ACTIVE', goal: { userId } } },
          },
          select: { id: true, version: true, targetPath: true },
        })
        const taskById = new Map(tasks.map((task) => [task.id, task]))
        const retries = await tx.outboxEvent.findMany({
          where: {
            id: {
              in: deliveries.flatMap((delivery) =>
                delivery.evidenceRetryEventId ? [delivery.evidenceRetryEventId] : [],
              ),
            },
          },
          select: { id: true, deadLetteredAt: true, payload: true, schemaVersion: true },
        })
        const retryById = new Map(retries.map((event) => [event.id, event]))
        const result: RepositoryEvidenceResponse = { repositoryId, deliveries: [] }
        for (const delivery of deliveries) {
          const push = githubPushPayloadSchema.safeParse(delivery.payload)
          if (
            !push.success ||
            push.data.installation.id !== repository.installationId ||
            push.data.repository.id !== repository.githubRepositoryId
          )
            continue
          const summary = {
            deliveryId: delivery.id,
            commitSha: push.data.after,
            receivedAt: delivery.receivedAt.toISOString(),
            attemptCount: delivery.evidenceAttemptCount,
            lastAttemptAt: delivery.evidenceLastAttemptAt?.toISOString() ?? null,
          }
          const event = eventById.get(delivery.id)
          if (!event) {
            if (
              delivery.status !== 'IGNORED' ||
              !delivery.ignoreReason ||
              !Object.hasOwn(intakeIgnoreReasons, delivery.ignoreReason) ||
              delivery.evidenceAttemptCount !== 0 ||
              delivery.evidenceLastAttemptAt ||
              delivery.evidenceRetryEventId ||
              delivery.submissionId ||
              delivery.agentRunId
            )
              continue
            result.deliveries.push({
              ...summary,
              taskId: null,
              targetPath: null,
              status: 'IGNORED',
              message: intakeIgnoreReasons[delivery.ignoreReason]!,
              canRetry: false,
              canResync: false,
            })
            continue
          }
          const context = githubPushReceivedEventPayloadSchema.safeParse(event.payload)
          if (
            event.schemaVersion !== GITHUB_PUSH_RECEIVED_SCHEMA_VERSION ||
            !context.success ||
            context.data.deliveryId !== delivery.id ||
            context.data.binding.userId !== userId ||
            context.data.binding.repositoryId !== repositoryId ||
            push.data.ref !== `refs/heads/${repository.branch}`
          )
            continue
          const deadLetteredAt = delivery.evidenceRetryEventId
            ? (retryById.get(delivery.evidenceRetryEventId)?.deadLetteredAt ?? null)
            : event.deadLetteredAt
          const retry = delivery.evidenceRetryEventId
            ? retryById.get(delivery.evidenceRetryEventId)
            : undefined
          const recovery = githubEvidenceRetryEventSchema.safeParse(retry)
          const snapshot =
            delivery.status === 'PROCESSED'
              ? delivery.submission?.evidence?.mode === 'SNAPSHOT'
              : recovery.success && recovery.data.payload.evidenceMode === 'SNAPSHOT'
          const state = visibleState(delivery, deadLetteredAt)
          if (!state) continue
          if (snapshot) state.message = `本轮为全文快照取证，原始 Diff 不可用；${state.message}`
          const task = taskById.get(context.data.task.taskId)
          const eligible =
            context.data.binding.repositoryVersion === repository.user.repositoryVersion &&
            task?.version === context.data.task.taskVersion &&
            task.targetPath === context.data.task.targetPath
          if (['FAILED', 'RESYNC_REQUIRED'].includes(state.status) && !eligible)
            state.message += ' 原绑定版本或任务已变化，不能用这条旧通知重新取证。'
          result.deliveries.push({
            ...summary,
            taskId: context.data.task.taskId,
            targetPath: context.data.task.targetPath,
            canRetry:
              state.status === 'FAILED' &&
              eligible &&
              delivery.evidenceAttemptCount > 0 &&
              retryableEvidenceFailureSchema.safeParse(delivery.evidenceLastErrorCode).success,
            canResync:
              state.status === 'RESYNC_REQUIRED' &&
              eligible &&
              delivery.evidenceAttemptCount > 0 &&
              !push.data.deleted &&
              !/^0+$/.test(push.data.after),
            ...state,
          })
        }
        return result
      },
      { isolationLevel: 'RepeatableRead' },
    )
  }
}

function visibleState(delivery: Delivery, deadLetteredAt: Date | null): VisibleState | null {
  // 已保存结果优先于历史错误；取证成功不等于语义验收通过。
  if (delivery.status === 'PROCESSED')
    return {
      status: 'COLLECTED',
      message: delivery.agentRunId
        ? '证据已保存，验收运行已创建；这不代表验收通过。'
        : '证据已保存，本次未创建语义验收运行（例如目标文件被删除）。',
    }
  if (delivery.status === 'IGNORED')
    return {
      status: 'IGNORED',
      message: safeReason(delivery.ignoreReason) ?? '本次通知不符合处理条件，未继续验收。',
    }
  if (delivery.status !== 'ACCEPTED') return null
  if (deadLetteredAt)
    return {
      status: 'DISPATCH_FAILED',
      message: '队列投递已停止，需要排查投递服务；这不是任务验收失败。',
    }
  const reason = safeReason(delivery.evidenceLastErrorCode) ?? '取证处理未完成。'
  if (delivery.evidenceFailedAt)
    return {
      status: delivery.evidenceLastErrorCode === 'RESYNC_REQUIRED' ? 'RESYNC_REQUIRED' : 'FAILED',
      message: `${reason} 本轮自动尝试已停止，未产生新的验收结论。`,
    }
  if (delivery.evidenceLastErrorCode)
    return {
      status: 'RETRYING',
      message: delivery.evidenceRetryEventId
        ? '恢复请求已记录，等待本轮取证结果；不代表 Worker 在线或验收通过，可稍后刷新。'
        : `${reason} 最近一次尝试失败，尚未记录最终结果；可稍后刷新。`,
    }
  return {
    status: 'PENDING',
    message: '已接收，尚无已保存的取证结果；可能等待队列或正在取证，不代表 Worker 当前在线。',
  }
}
