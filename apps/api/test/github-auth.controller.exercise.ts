import { Test } from '@nestjs/testing'
import type { ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'

import { AuthController } from '../src/identity/auth.controller.js'
import type { AuthRequest } from '../src/identity/auth-http.js'
import { AuthService, LoginFailure } from '../src/identity/auth.service.js'

// 只写下面三个测试；夹具负责 Nest 装配，不启动 HTTP、数据库或真实 GitHub 请求。
// 题面：docs/handwrite/r04-github-callback-controller.md。写断言时从 vitest 补充导入 expect。
async function createFixture() {
  const webOrigin = 'http://127.0.0.1:3000'
  const sessionCookie =
    'knowledgeops_session=r04-fixture-only; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800'
  const clearedStateCookie = 'knowledgeops_oauth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
  const auth = {
    environment: { WEB_ORIGIN: webOrigin },
    completeLogin: vi.fn<AuthService['completeLogin']>(),
    clearCookie: vi.fn<AuthService['clearCookie']>().mockReturnValue(clearedStateCookie),
  }
  const reply = { writeHead: vi.fn(), end: vi.fn() }
  const moduleRef = await Test.createTestingModule({
    controllers: [AuthController],
    providers: [{ provide: AuthService, useValue: auth }],
  }).compile()

  return {
    moduleRef,
    controller: moduleRef.get(AuthController),
    auth,
    query: { code: 'fixture-code', state: 'fixture-state' },
    request: { headers: { cookie: 'knowledgeops_oauth=fixture-state' } } as AuthRequest,
    response: reply as unknown as ServerResponse,
    reply,
    webOrigin,
    sessionCookie,
    clearedStateCookie,
    invalidStateError: new LoginFailure('invalid-state'),
    unexpectedError: new Error('FIXTURE_ONLY_INTERNAL_DETAIL_DO_NOT_EXPOSE'),
  }
}

let f: Awaited<ReturnType<typeof createFixture>>

beforeEach(async () => {
  f = await createFixture()
})

afterEach(async () => {
  await f?.moduleRef.close()
})

// 每题的 f 都是全新夹具。保留测试名称；用你的模拟、调用和断言替换 TODO 抛错。
describe('R04 GitHub callback Controller', () => {
  it('successful callback sets the session and redirects to the workspace', async () => {
    f.auth.completeLogin.mockResolvedValue(f.sessionCookie)
    await f.controller.callback(f.query, f.request, f.response)
    expect(f.auth.completeLogin).toHaveBeenCalledTimes(1)
    expect(f.auth.completeLogin).toHaveBeenCalledWith(f.query, f.request)
    expect(f.auth.clearCookie).toHaveBeenCalledTimes(1)
    expect(f.auth.clearCookie).toHaveBeenCalledWith('state')
    expect(f.reply.writeHead).toHaveBeenCalledTimes(1)
    expect(f.reply.writeHead).toHaveBeenCalledWith(
      302,
      expect.objectContaining({
        Location: `${f.webOrigin}/app/plan`,
        'Set-Cookie': [f.clearedStateCookie, f.sessionCookie],
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      }),
    )
    expect(f.reply.end).toHaveBeenCalledTimes(1)
  })

  it('invalid state clears the temporary cookie without issuing a session', async () => {
    // TODO(user): 模拟明确的登录失败，检查失败跳转和只清除临时 Cookie。
    f.auth.completeLogin.mockRejectedValue(f.invalidStateError)
    await f.controller.callback(f.query, f.request, f.response)
    expect(f.auth.completeLogin).toHaveBeenCalledTimes(1)
    expect(f.auth.completeLogin).toHaveBeenCalledWith(f.query, f.request)
    expect(f.auth.clearCookie).toHaveBeenCalledTimes(1)
    expect(f.auth.clearCookie).toHaveBeenCalledWith('state')
    expect(f.reply.writeHead).toHaveBeenCalledTimes(1)
    expect(f.reply.writeHead).toHaveBeenCalledWith(
      302,
      expect.objectContaining({
        Location: `${f.webOrigin}/login?error=${f.invalidStateError.reason}`,
        'Set-Cookie': [f.clearedStateCookie],
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      }),
    )
    expect(f.reply.end).toHaveBeenCalledTimes(1)
  })

  it('unexpected failure is redirected with a safe fixed reason', async () => {
    // TODO(user): 模拟未知异常，检查固定错误原因、不发会话和不泄露内部错误。
    f.auth.completeLogin.mockRejectedValue(f.unexpectedError)
    await f.controller.callback(f.query, f.request, f.response)
    expect(f.auth.completeLogin).toHaveBeenCalledTimes(1)
    expect(f.auth.completeLogin).toHaveBeenCalledWith(f.query, f.request)
    expect(f.auth.clearCookie).toHaveBeenCalledTimes(1)
    expect(f.auth.clearCookie).toHaveBeenCalledWith('state')
    expect(f.reply.writeHead).toHaveBeenCalledTimes(1)
    expect(f.reply.writeHead).toHaveBeenCalledWith(
      302,
      expect.objectContaining({
        Location: `${f.webOrigin}/login?error=session-unavailable`,
        'Set-Cookie': [f.clearedStateCookie],
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      }),
    )
    f.reply.writeHead.mock.calls.forEach((call) =>
      expect(JSON.stringify(call)).not.toContain(f.unexpectedError.message),
    )
    f.reply.end.mock.calls.forEach((call) =>
      expect(JSON.stringify(call)).not.toContain(f.unexpectedError.message),
    )
    expect(f.reply.end).toHaveBeenCalledTimes(1)
  })
})
