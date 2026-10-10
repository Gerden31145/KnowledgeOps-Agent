import {
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { ServerResponse } from 'node:http'

import { AuthService } from './auth.service.js'
import type { AuthRequest } from './auth-http.js'

const PUBLIC_ROUTE = 'knowledgeops.public-route'
export const PublicRoute = () => SetMetadata(PUBLIC_ROUTE, true)
const SIGNED_WEBHOOK_ROUTE = 'knowledgeops.signed-webhook-route'
// 仅用于服务端通知入口；标记不执行验签，业务入口必须在读写数据前验证签名。
export const SignedWebhookRoute = () => SetMetadata(SIGNED_WEBHOOK_ROUTE, true)

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthRequest>()
    context.switchToHttp().getResponse<ServerResponse>().setHeader('Cache-Control', 'no-store')
    // Webhook 使用独立签名认证，不依赖浏览器 Origin 或登录 Cookie。
    if (
      this.reflector.getAllAndOverride<boolean>(SIGNED_WEBHOOK_ROUTE, [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true
    // SameSite 不是授权校验；写请求再核对浏览器 Origin，拒绝缺失/其他来源。
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method ?? '') &&
      request.headers.origin !== this.auth.environment.WEB_ORIGIN
    ) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Request origin is not allowed' })
    }
    if (
      this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true
    await this.auth.requireUser(request)
    return true
  }
}
