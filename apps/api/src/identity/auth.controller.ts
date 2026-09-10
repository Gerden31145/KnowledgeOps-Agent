import { Controller, Get, Inject, Post, Query, Req, Res } from '@nestjs/common'
import type { ServerResponse } from 'node:http'
import type { SessionResponse } from '@knowledgeops/contracts'

import type { AuthRequest } from './auth-http.js'
import { PublicRoute } from './auth.guard.js'
import { AuthService, LoginFailure } from './auth.service.js'

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @PublicRoute()
  @Get('github/login')
  login(@Req() request: AuthRequest, @Res() response: ServerResponse): void {
    const attempt = this.auth.beginLogin(request)
    this.redirect(response, attempt.location, [attempt.cookie])
  }

  @PublicRoute()
  @Get('github/callback')
  async callback(
    @Query() query: unknown,
    @Req() request: AuthRequest,
    @Res() response: ServerResponse,
  ): Promise<void> {
    try {
      const cookie = await this.auth.completeLogin(query, request)
      this.redirect(response, `${this.auth.environment.WEB_ORIGIN}/app/plan`, [
        this.auth.clearCookie('state'),
        cookie,
      ])
    } catch (error: unknown) {
      const reason = error instanceof LoginFailure ? error.reason : 'session-unavailable'
      this.redirect(response, `${this.auth.environment.WEB_ORIGIN}/login?error=${reason}`, [
        this.auth.clearCookie('state'),
      ])
    }
  }

  @Get('session')
  async session(@Req() request: AuthRequest): Promise<SessionResponse> {
    return { user: await this.auth.requireUser(request) }
  }

  @PublicRoute()
  @Post('logout')
  async logout(@Req() request: AuthRequest, @Res() response: ServerResponse): Promise<void> {
    await this.auth.logout(request)
    response.writeHead(204, {
      'Set-Cookie': this.auth.clearCookie('session'),
      'Cache-Control': 'no-store',
    })
    response.end()
  }

  private redirect(response: ServerResponse, location: string, cookies: string[]): void {
    response.writeHead(302, {
      Location: location,
      'Set-Cookie': cookies,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    })
    response.end()
  }
}
