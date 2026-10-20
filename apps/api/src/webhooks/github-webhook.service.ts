import { createHash } from 'node:crypto'
import {
  BadRequestException,
  ConflictException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common'
import {
  CURRENT_TASK_STATES,
  GITHUB_PUSH_RECEIVED_SCHEMA_VERSION,
  githubPushPayloadSchema,
  githubPushReceivedEventPayloadSchema,
  markdownTargetPathSchema,
} from '@knowledgeops/contracts'
import { Prisma, type DatabaseClient } from '@knowledgeops/database'
import { z } from 'zod'
import { verifyGitHubWebhookSignature } from './github-webhook-signature.exercise.js'

const metadataSchema = z.object({
  deliveryId: z.uuid(),
  eventType: z.string().regex(/^[a-z_]{1,64}$/),
})
const invalid = () =>
  new BadRequestException({ code: 'WEBHOOK_PAYLOAD_INVALID', message: 'Invalid webhook payload.' })
const received = () => ({ received: true as const })

export interface GitHubDeliveryInput {
  rawBody: Buffer
  signature: string | undefined
  deliveryId: string | undefined
  eventType: string | undefined
}

export class GitHubWebhookService {
  constructor(
    private readonly database: DatabaseClient,
    private readonly secret: string | undefined,
    private readonly verify = verifyGitHubWebhookSignature,
  ) {}

  async receive(input: GitHubDeliveryInput) {
    if (!this.secret)
      throw new ServiceUnavailableException({
        code: 'WEBHOOK_NOT_CONFIGURED',
        message: 'Webhook is not configured.',
      })
    if (input.rawBody.length > 100 * 1024) throw new PayloadTooLargeException()
    // 1. 未验证请求不能读写接收表或探测本地仓库绑定；不要在日志中输出密钥/签名/正文。
    if (!this.verify({ rawBody: input.rawBody, signature: input.signature, secret: this.secret }))
      throw new UnauthorizedException({
        code: 'WEBHOOK_SIGNATURE_INVALID',
        message: 'Invalid signature.',
      })
    const metadata = metadataSchema.safeParse(input)
    if (!metadata.success) throw invalid()
    const deliveryId = metadata.data.deliveryId.toLowerCase()
    const { eventType } = metadata.data
    let body: unknown
    try {
      body = JSON.parse(input.rawBody.toString('utf8'))
    } catch {
      throw invalid()
    }
    const parsed = eventType === 'push' ? githubPushPayloadSchema.safeParse(body) : undefined
    if (parsed && !parsed.success) throw invalid()
    const push = parsed?.success ? parsed.data : undefined
    const payloadHash = createHash('sha256').update(input.rawBody).digest('hex')
    const initialReason = !push
      ? 'EVENT_UNSUPPORTED'
      : !push.ref.startsWith('refs/heads/')
        ? 'REF_UNSUPPORTED'
        : push.deleted || /^0+$/.test(push.after)
          ? 'BRANCH_DELETED'
          : null

    // 2. 唯一 Delivery、接收上下文与取证 Outbox 同事务；不调用 GitHub 或创建验收 Run。
    return this.database.$transaction(async (tx) => {
      const inserted = await tx.webhookDelivery.createMany({
        data: [
          {
            id: deliveryId,
            eventType,
            payloadHash,
            status: initialReason ? 'IGNORED' : 'ACCEPTED',
            ignoreReason: initialReason,
            payload: push ?? {},
          },
        ],
        skipDuplicates: true,
      })
      if (inserted.count === 0) {
        const existing = await tx.webhookDelivery.findUniqueOrThrow({ where: { id: deliveryId } })
        if (existing.payloadHash !== payloadHash || existing.eventType !== eventType)
          throw new ConflictException({
            code: 'WEBHOOK_DELIVERY_CONFLICT',
            message: 'Delivery content conflicts.',
          })
        return received()
      }
      if (!push) return received()

      // 3. 绑定来自数据库，不相信 sender/login/full_name；绑定与解绑共用 User 行锁。
      const where = {
        enabled: true,
        installationId: push.installation.id,
        githubRepositoryId: push.repository.id,
      }
      // 仓库活动绑定独占：最多匹配一条，不展开多个用户。
      const matched = await tx.repository.findFirst({ where, select: { id: true, userId: true } })
      if (matched) {
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM users WHERE id = ${matched.userId}::uuid FOR UPDATE`,
        )
      }
      // 只重查原绑定：中途解绑/换人重绑，不能将这次通知转给新的绑定者。
      const binding = matched
        ? await tx.repository.findFirst({
            where: { ...where, id: matched.id, userId: matched.userId },
            select: {
              id: true,
              userId: true,
              branch: true,
              user: { select: { repositoryVersion: true } },
            },
          })
        : null
      if (!binding) {
        await tx.webhookDelivery.update({
          where: { id: deliveryId },
          data: { status: 'IGNORED', ignoreReason: initialReason ?? 'NO_ACTIVE_BINDING' },
        })
        return received()
      }

      // 先冻结归属，再决定是否取证；无任务/非目标分支也不需要制造一个 Outbox。
      // 重复 Delivery 在上方直接返回，不能用后来重绑的仓库认领这条旧通知。
      const receiptIgnoreReason =
        initialReason ?? (push.ref === `refs/heads/${binding.branch}` ? null : 'BRANCH_NOT_TRACKED')
      await tx.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          receivedRepositoryId: binding.id,
          ...(receiptIgnoreReason ? { status: 'IGNORED', ignoreReason: receiptIgnoreReason } : {}),
        },
      })
      if (receiptIgnoreReason) return received()

      // 4. 和开始任务共用 User 锁：固化接收时的任务，不等消费时重新挑一个。
      // 查询两条足以发现歧义；不能用 findFirst 随意认领，也不能过滤掉缺失路径的任务。
      const tasks = await tx.task.findMany({
        where: {
          type: 'MARKDOWN_NOTE',
          state: { in: [...CURRENT_TASK_STATES] },
          stage: { plan: { status: 'ACTIVE', goal: { userId: binding.userId } } },
        },
        select: { id: true, version: true, targetPath: true },
        take: 2,
      })
      const task = tasks.length === 1 ? tasks[0] : undefined
      const path = markdownTargetPathSchema.safeParse(task?.targetPath)
      const ignoreReason = !tasks.length
        ? 'NO_CURRENT_TASK'
        : tasks.length > 1
          ? 'AMBIGUOUS_CURRENT_TASK'
          : !path.success || path.data !== task?.targetPath
            ? 'INVALID_TARGET_PATH'
            : null
      if (ignoreReason || !task || !path.success) {
        await tx.webhookDelivery.update({
          where: { id: deliveryId },
          data: { status: 'IGNORED', ignoreReason: ignoreReason ?? 'INVALID_TARGET_PATH' },
        })
        return received()
      }

      const context = githubPushReceivedEventPayloadSchema.parse({
        deliveryId,
        binding: {
          repositoryId: binding.id,
          userId: binding.userId,
          repositoryVersion: binding.user.repositoryVersion,
        },
        task: { taskId: task.id, taskVersion: task.version, targetPath: path.data },
      })
      await tx.outboxEvent.create({
        data: {
          type: 'GITHUB_PUSH_RECEIVED',
          aggregateId: deliveryId,
          deduplicationKey: `github-push-received-${deliveryId}`,
          schemaVersion: GITHUB_PUSH_RECEIVED_SCHEMA_VERSION,
          payload: context,
        },
      })
      // 不返回用户/仓库内部信息；202 只承诺接收意图持久化，不承诺 Diff/Agent 已执行。
      return received()
    })
  }
}
