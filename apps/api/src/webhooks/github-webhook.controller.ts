import {
  BadRequestException,
  Controller,
  Header,
  HttpCode,
  Inject,
  Post,
  Req,
  UnsupportedMediaTypeException,
  type RawBodyRequest,
} from '@nestjs/common'
import type { IncomingMessage } from 'node:http'
import { SignedWebhookRoute } from '../identity/auth.guard.js'
import { GitHubWebhookService } from './github-webhook.service.js'

@Controller('webhooks/github')
export class GitHubWebhookController {
  constructor(@Inject(GitHubWebhookService) private readonly webhooks: GitHubWebhookService) {}

  // 这是 GitHub 服务器的请求，不依赖用户 Cookie 或浏览器 Origin；信任入口是验签。
  @SignedWebhookRoute()
  @Post()
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  async receive(@Req() request: RawBodyRequest<IncomingMessage>) {
    const contentType = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase()
    if (
      contentType !== 'application/json' ||
      (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity')
    )
      throw new UnsupportedMediaTypeException({
        code: 'WEBHOOK_MEDIA_TYPE_INVALID',
        message: 'Webhook requires uncompressed JSON.',
      })
    if (!Buffer.isBuffer(request.rawBody))
      throw new BadRequestException({ code: 'WEBHOOK_BODY_INVALID', message: 'Missing raw body.' })
    const header = (name: string) => {
      const value = request.headers[name]
      return typeof value === 'string' ? value : undefined
    }
    return this.webhooks.receive({
      rawBody: request.rawBody,
      signature: header('x-hub-signature-256'),
      deliveryId: header('x-github-delivery'),
      eventType: header('x-github-event'),
    })
  }
}
