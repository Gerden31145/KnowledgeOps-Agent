import { createHash } from 'node:crypto'
import {
  HttpException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common'
import { z } from 'zod'

import type { ApiEnvironment } from '../config/environment.js'
import type { DatabaseService } from '../database/database.service.js'
import {
  authCookie,
  hashToken,
  opaqueToken,
  OAUTH_TTL_SECONDS,
  readCookie,
  SESSION_TTL_SECONDS,
  tokensMatch,
  type AuthRequest,
  type AuthUser,
} from './auth-http.js'

const callbackSchema = z.object({
  state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code: z.string().min(1).max(1024).optional(),
  error: z.string().max(200).optional(),
})
const githubTokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.literal('bearer'),
  expires_in: z.number().int().positive().optional(),
  error: z.never().optional(),
})
const githubUserSchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  login: z.string().min(1).max(100),
})
export class LoginFailure extends Error {
  constructor(
    readonly reason:
      'invalid-state' | 'access-denied' | 'github-unavailable' | 'session-unavailable',
  ) {
    super(reason)
  }
}

@Injectable()
export class AuthService {
  private readonly attempts = new Map<string, { verifier: string; expiresAt: number }>()
  private readonly startsByAddress = new Map<string, { count: number; expiresAt: number }>()
  // 仅用于用户主动绑定时的 GitHub 权限核验，不持久化、不发送至浏览器。
  private readonly githubGrants = new Map<string, { token: string; expiresAt: number }>()
  readonly secure: boolean
  readonly sessionCookieName: string
  readonly stateCookieName: string

  constructor(
    private readonly database: DatabaseService,
    readonly environment: ApiEnvironment,
    private readonly fetchGitHub: typeof fetch = fetch,
  ) {
    this.secure =
      environment.GITHUB_APP_CALLBACK_URL?.startsWith('https:') ??
      environment.NODE_ENV === 'production'
    this.sessionCookieName = this.secure ? '__Host-knowledgeops_session' : 'knowledgeops_session'
    this.stateCookieName = this.secure ? '__Host-knowledgeops_oauth' : 'knowledgeops_oauth'
  }

  // 1. 已学过的 OAuth 入口：本 API 进程保存短期尝试，Cookie 绑定发起浏览器。
  beginLogin(request: AuthRequest): { location: string; cookie: string } {
    const config = this.githubConfig()
    const now = Date.now()
    for (const [key, value] of this.attempts) if (value.expiresAt <= now) this.attempts.delete(key)
    for (const [key, value] of this.startsByAddress)
      if (value.expiresAt <= now) this.startsByAddress.delete(key)
    const address = request.socket.remoteAddress ?? 'unknown'
    const limit = this.startsByAddress.get(address) ?? {
      count: 0,
      expiresAt: now + OAUTH_TTL_SECONDS * 1000,
    }
    if (limit.count >= 10 || this.attempts.size >= 200 || this.startsByAddress.size >= 2000) {
      throw new HttpException(
        { code: 'RATE_LIMITED', message: 'Too many login attempts; try again later' },
        429,
      )
    }
    limit.count += 1
    this.startsByAddress.set(address, limit)
    const previous = readCookie(request, this.stateCookieName)
    if (previous) this.attempts.delete(hashToken(previous))
    const state = opaqueToken()
    const verifier = opaqueToken()
    this.attempts.set(hashToken(state), { verifier, expiresAt: now + OAUTH_TTL_SECONDS * 1000 })
    const url = new URL('https://github.com/login/oauth/authorize')
    url.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.callbackUrl,
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString()
    return {
      location: url.toString(),
      cookie: authCookie(this.stateCookieName, state, OAUTH_TTL_SECONDS, this.secure),
    }
  }

  async completeLogin(query: unknown, request: AuthRequest): Promise<string> {
    const parsed = callbackSchema.safeParse(query)
    const state = parsed.success ? parsed.data.state : undefined
    const key = state ? hashToken(state) : ''
    const attempt = this.attempts.get(key)
    if (
      !parsed.success ||
      !attempt ||
      attempt.expiresAt <= Date.now() ||
      !tokensMatch(state, readCookie(request, this.stateCookieName))
    ) {
      throw new LoginFailure('invalid-state')
    }
    // 在第一个 await 前消费：并发/重放也不能二次换令牌或建立会话。
    this.attempts.delete(key)
    if (parsed.data.error) throw new LoginFailure('access-denied')
    if (!parsed.data.code) throw new LoginFailure('invalid-state')
    const { user: githubUser, grant } = await this.exchangeIdentity(
      parsed.data.code,
      attempt.verifier,
    )
    const token = opaqueToken()
    const previous = readCookie(request, this.sessionCookieName)

    // 2. 新概念：GitHub 身份对应本项目 User；只持久化随机会话凭据的哈希。
    try {
      await this.database.client.$transaction(async (tx) => {
        const user = await tx.user.upsert({
          where: { githubUserId: String(githubUser.id) },
          create: { githubUserId: String(githubUser.id), githubLogin: githubUser.login },
          update: { githubLogin: githubUser.login },
        })
        if (previous) await tx.session.deleteMany({ where: { tokenHash: hashToken(previous) } })
        await tx.session.deleteMany({ where: { userId: user.id, expiresAt: { lte: new Date() } } })
        await tx.session.create({
          data: {
            tokenHash: hashToken(token),
            userId: user.id,
            expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
          },
        })
      })
    } catch {
      throw new LoginFailure('session-unavailable')
    }
    if (previous) this.githubGrants.delete(hashToken(previous))
    this.pruneGrants()
    if (this.githubGrants.size >= 200)
      this.githubGrants.delete(this.githubGrants.keys().next().value!)
    this.githubGrants.set(hashToken(token), grant)
    return authCookie(this.sessionCookieName, token, SESSION_TTL_SECONDS, this.secure)
  }

  async requireGitHubToken(request: AuthRequest): Promise<string> {
    await this.requireUser(request)
    this.pruneGrants()
    const token = readCookie(request, this.sessionCookieName)
    const grant = token ? this.githubGrants.get(hashToken(token)) : undefined
    if (!grant)
      throw new ConflictException({
        code: 'CONFLICT',
        reason: 'GITHUB_AUTH_REQUIRED',
        message: '请重新通过 GitHub 授权，以核验仓库权限；已有项目会话与绑定未失效。',
      })
    return grant.token
  }

  private pruneGrants(): void {
    for (const [key, grant] of this.githubGrants) {
      if (grant.expiresAt <= Date.now()) this.githubGrants.delete(key)
    }
  }

  // 3. 后续请求不再询问 GitHub：用 Cookie 查 PostgreSQL，每个请求最多查一次。
  requireUser(request: AuthRequest): Promise<AuthUser> {
    request.sessionUser ??= this.lookupUser(request)
    return request.sessionUser
  }

  async logout(request: AuthRequest): Promise<void> {
    const token = readCookie(request, this.sessionCookieName)
    if (token)
      await this.database.client.session.deleteMany({ where: { tokenHash: hashToken(token) } })
    if (token) this.githubGrants.delete(hashToken(token))
  }

  clearCookie(kind: 'state' | 'session'): string {
    return authCookie(
      kind === 'state' ? this.stateCookieName : this.sessionCookieName,
      '',
      0,
      this.secure,
    )
  }

  private async lookupUser(request: AuthRequest): Promise<AuthUser> {
    const token = readCookie(request, this.sessionCookieName)
    const session = token
      ? await this.database.client.session.findUnique({
          where: { tokenHash: hashToken(token) },
          select: {
            expiresAt: true,
            user: { select: { id: true, githubLogin: true, timezone: true } },
          },
        })
      : null
    if (!session || session.expiresAt <= new Date() || !session.user.githubLogin) {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'Please sign in with GitHub',
      })
    }
    return { ...session.user, githubLogin: session.user.githubLogin }
  }

  private githubConfig() {
    const {
      GITHUB_APP_CLIENT_ID: clientId,
      GITHUB_APP_CLIENT_SECRET: clientSecret,
      GITHUB_APP_CALLBACK_URL: callbackUrl,
    } = this.environment
    if (!clientId || !clientSecret || !callbackUrl) {
      throw new ServiceUnavailableException({
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'GitHub login is not configured',
      })
    }
    return { clientId, clientSecret, callbackUrl }
  }

  private async exchangeIdentity(code: string, verifier: string) {
    const config = this.githubConfig()
    try {
      const tokenResponse = await this.fetchGitHub('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: config.callbackUrl,
          code,
          code_verifier: verifier,
        }),
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      })
      if (!tokenResponse.ok) throw new Error('token-request-failed')
      const token = githubTokenSchema.parse(await tokenResponse.json())
      const userResponse = await this.fetchGitHub('https://api.github.com/user', {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token.access_token}`,
          'user-agent': 'KnowledgeOps-Agent',
          'x-github-api-version': '2026-03-10',
        },
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      })
      if (!userResponse.ok) throw new Error('user-request-failed')
      return {
        user: githubUserSchema.parse(await userResponse.json()),
        grant: {
          token: token.access_token,
          expiresAt: Date.now() + Math.min(token.expires_in ?? 600, 600) * 1000,
        },
      }
    } catch {
      // 不记录上游正文、code、Token、配置或原始网络异常。
      throw new LoginFailure('github-unavailable')
    }
  }
}
