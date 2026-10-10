import { createHash } from 'node:crypto'
import {
  BadRequestException,
  ConflictException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common'
import { githubIdSchema } from '@knowledgeops/contracts'
import { Prisma, type DatabaseClient } from '@knowledgeops/database'
import { z } from 'zod'
import { verifyGitHubWebhookSignature } from './github-webhook-signature.exercise.js'

const id = z.union([githubIdSchema, z.number().int().positive().safe().transform(String)])
const sha = z
  .string()
  .regex(/^[a-fA-F0-9]{40}$/)
  .transform((value) => value.toLowerCase())
// 只保存后续取证所需的最少字段；不保存 sender、commit message 等整个私有 payload。
const pushSchema = z.object({
  installation: z.object({ id }),
  repository: z.object({ id }),
  ref: z.string().min(1).max(1024),
  before: sha,
  after: sha,
  deleted: z.boolean(),
  forced: z.boolean(),
})
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
    const parsed = eventType === 'push' ? pushSchema.safeParse(body) : undefined
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

    // 2. 唯一 Delivery 与 Outbox 同事务；ON CONFLICT 不会把事务置为错误状态。
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
      if (initialReason || !push) return received()

      // 3. 绑定来自数据库，不相信 sender/login/full_name；绑定与解绑共用 User 行锁。
      const where = {
        enabled: true,
        installationId: push.installation.id,
        githubRepositoryId: push.repository.id,
        branch: push.ref.slice('refs/heads/'.length),
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
            select: { id: true, userId: true, user: { select: { repositoryVersion: true } } },
          })
        : null
      if (!binding) {
        await tx.webhookDelivery.update({
          where: { id: deliveryId },
          data: { status: 'IGNORED', ignoreReason: 'NO_ACTIVE_BINDING' },
        })
        return received()
      }
      await tx.outboxEvent.create({
        data: {
          type: 'GITHUB_PUSH_RECEIVED',
          aggregateId: deliveryId,
          deduplicationKey: `github-push-received-${deliveryId}`,
          payload: {
            deliveryId,
            // 保持已保存的 schemaVersion=1 格式；新事件只允许一个绑定元素。
            bindings: [
              {
                repositoryId: binding.id,
                userId: binding.userId,
                repositoryVersion: binding.user.repositoryVersion,
              },
            ],
          },
        },
      })
      // 不返回用户/仓库内部信息；202 只承诺接收意图持久化，不承诺 Diff/Agent 已执行。
      return received()
    })
  }
}
