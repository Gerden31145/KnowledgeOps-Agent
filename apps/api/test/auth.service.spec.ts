import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'

import { readApiEnvironment } from '../src/config/environment.js'
import type { DatabaseService } from '../src/database/database.service.js'
import {
  authCookie,
  hashToken,
  opaqueToken,
  readCookie,
  type AuthRequest,
} from '../src/identity/auth-http.js'
import { AuthService } from '../src/identity/auth.service.js'

const environment = readApiEnvironment({
  GITHUB_APP_CLIENT_ID: 'test-client',
  GITHUB_APP_CLIENT_SECRET: 'test-secret',
  GITHUB_APP_CALLBACK_URL: 'http://127.0.0.1:4000/auth/github/callback',
})
const request = (cookie?: string) =>
  ({ headers: cookie ? { cookie } : {}, socket: { remoteAddress: '127.0.0.1' } }) as AuthRequest

function fixture() {
  const user = { id: randomUUID(), githubLogin: 'fixture-user', timezone: 'Asia/Shanghai' }
  const tx = {
    user: { upsert: vi.fn().mockResolvedValue(user) },
    session: {
      create: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      findUnique: vi.fn(),
    },
  }
  const database = {
    client: { ...tx, $transaction: vi.fn(async (operation) => operation(tx)) },
  } as unknown as DatabaseService
  const upstream = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({ access_token: 'test-github-token', token_type: 'bearer' }),
    )
    .mockResolvedValueOnce(Response.json({ id: 123, login: user.githubLogin }))
  const auth = new AuthService(database, environment, upstream)
  const begin = () => {
    const attempt = auth.beginLogin(request())
    return {
      state: new URL(attempt.location).searchParams.get('state')!,
      cookie: attempt.cookie.split(';')[0]!,
      location: attempt.location,
    }
  }
  return { auth, begin, tx, database, upstream, user }
}

afterEach(() => vi.useRealTimers())

describe('GitHub identity and persistent session service (not the Controller exercise)', () => {
  it('keeps a short-lived server-only GitHub grant scoped to the new session and clears it on logout', async () => {
    const f = fixture()
    const attempt = f.begin()
    const cookie = await f.auth.completeLogin(
      { state: attempt.state, code: 'fixture-code' },
      request(attempt.cookie),
    )
    f.tx.session.findUnique.mockResolvedValue({
      expiresAt: new Date(Date.now() + 3600_000),
      user: f.user,
    })
    const session = cookie.split(';')[0]!
    await expect(f.auth.requireGitHubToken(request(session))).resolves.toBe('test-github-token')
    await expect(
      f.auth.requireGitHubToken(request(`knowledgeops_session=${opaqueToken()}`)),
    ).rejects.toMatchObject({ response: { reason: 'GITHUB_AUTH_REQUIRED' } })
    expect(JSON.stringify(f.tx.session.create.mock.calls)).not.toContain('test-github-token')
    expect(cookie).not.toContain('test-github-token')
    await f.auth.logout(request(session))
    await expect(f.auth.requireGitHubToken(request(session))).rejects.toMatchObject({
      response: { reason: 'GITHUB_AUTH_REQUIRED' },
    })
  })

  it('does not treat an expired or restart-lost GitHub grant as an expired project session', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const attempt = f.begin()
    const cookie = await f.auth.completeLogin(
      { state: attempt.state, code: 'fixture-code' },
      request(attempt.cookie),
    )
    const session = cookie.split(';')[0]!
    f.tx.session.findUnique.mockResolvedValue({
      expiresAt: new Date(Date.now() + 3600_000),
      user: f.user,
    })
    await expect(
      new AuthService(f.database, environment).requireGitHubToken(request(session)),
    ).rejects.toMatchObject({ response: { reason: 'GITHUB_AUTH_REQUIRED' } })
    vi.advanceTimersByTime(600_000)
    await expect(f.auth.requireGitHubToken(request(session))).rejects.toMatchObject({
      response: { reason: 'GITHUB_AUTH_REQUIRED' },
    })
    await expect(f.auth.requireUser(request(session))).resolves.toEqual(f.user)
  })
  it('creates independent state/PKCE values and secure host cookies for HTTPS', () => {
    const f = fixture()
    const first = f.begin()
    const second = f.begin()
    expect(first.state).not.toBe(second.state)
    const url = new URL(first.location)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('client_secret')).toBeNull()
    expect(authCookie('__Host-test', opaqueToken(), 600, true)).toMatch(
      /Path=\/; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/,
    )
  })

  it.each([
    'missing-cookie',
    'wrong-cookie',
    'duplicate-cookie',
    'duplicate-state',
    'expired',
    'denied',
    'missing-code',
  ])('rejects %s before any upstream or database call', async (kind) => {
    const f = fixture()
    const attempt = f.begin()
    let cookie = attempt.cookie
    const query: Record<string, unknown> = { state: attempt.state, code: 'test-code' }
    if (kind === 'missing-cookie') cookie = ''
    if (kind === 'wrong-cookie') cookie = `knowledgeops_oauth=${opaqueToken()}`
    if (kind === 'duplicate-cookie') cookie += `; ${cookie}`
    if (kind === 'duplicate-state') query.state = [attempt.state, attempt.state]
    if (kind === 'expired') {
      vi.useFakeTimers()
      vi.setSystemTime(Date.now() + 600_001)
    }
    if (kind === 'denied') query.error = 'access_denied'
    if (kind === 'missing-code') delete query.code
    await expect(f.auth.completeLogin(query, request(cookie))).rejects.toMatchObject({
      reason: kind === 'denied' ? 'access-denied' : 'invalid-state',
    })
    expect(f.upstream).not.toHaveBeenCalled()
    expect(f.database.client.$transaction).not.toHaveBeenCalled()
  })

  it('upserts only the verified GitHub identity and stores a hash, not either raw token', async () => {
    const f = fixture()
    const attempt = f.begin()
    const previous = opaqueToken()
    const cookie = await f.auth.completeLogin(
      { state: attempt.state, code: 'test-code', userId: 'untrusted' },
      request(`${attempt.cookie}; knowledgeops_session=${previous}`),
    )
    const token = readCookie(request(cookie), f.auth.sessionCookieName)!
    expect(f.tx.user.upsert).toHaveBeenCalledWith({
      where: { githubUserId: '123' },
      create: { githubUserId: '123', githubLogin: f.user.githubLogin },
      update: { githubLogin: f.user.githubLogin },
    })
    expect(f.tx.session.create).toHaveBeenCalledWith({
      data: { userId: f.user.id, tokenHash: hashToken(token), expiresAt: expect.any(Date) },
    })
    expect(f.tx.session.deleteMany).toHaveBeenCalledWith({
      where: { tokenHash: hashToken(previous) },
    })
    expect(JSON.stringify(f.tx.session.create.mock.calls)).not.toContain(token)
    expect(cookie).not.toContain('test-github-token')
    const tokenBody = f.upstream.mock.calls[0]![1]!.body as URLSearchParams
    expect(tokenBody.get('code_verifier')).toHaveLength(43)
    expect(f.upstream.mock.calls[1]![1]!.headers).toMatchObject({
      authorization: 'Bearer test-github-token',
    })
    await expect(
      f.auth.completeLogin({ state: attempt.state, code: 'test-code' }, request(attempt.cookie)),
    ).rejects.toMatchObject({ reason: 'invalid-state' })
    expect(f.database.client.$transaction).toHaveBeenCalledTimes(1)
  })

  it('consumes an attempt synchronously so simultaneous callbacks cannot both commit', async () => {
    const f = fixture()
    const a = f.begin()
    const results = await Promise.allSettled(
      [1, 2].map(() => f.auth.completeLogin({ state: a.state, code: 'code' }, request(a.cookie))),
    )
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(f.tx.session.create).toHaveBeenCalledTimes(1)
  })

  it.each(['network', 'token-body', 'user-body', 'database'])(
    'redacts %s failure and never returns a session cookie',
    async (kind) => {
      const f = fixture()
      if (kind === 'network')
        f.upstream.mockReset().mockRejectedValue(new Error('test-secret test-github-token'))
      if (kind === 'token-body')
        f.upstream.mockReset().mockResolvedValue(Response.json({ error: 'test-secret' }))
      if (kind === 'user-body')
        f.upstream
          .mockReset()
          .mockResolvedValueOnce(
            Response.json({ access_token: 'test-github-token', token_type: 'bearer' }),
          )
          .mockResolvedValueOnce(Response.json({ id: -1, login: 'invalid' }))
      if (kind === 'database')
        vi.spyOn(f.database.client, '$transaction').mockRejectedValue(new Error('test-secret'))
      const a = f.begin()
      await expect(
        f.auth.completeLogin({ state: a.state, code: 'code' }, request(a.cookie)),
      ).rejects.toMatchObject({
        message: kind === 'database' ? 'session-unavailable' : 'github-unavailable',
      })
      if (kind !== 'database') expect(f.tx.session.create).not.toHaveBeenCalled()
    },
  )

  it('checks database expiry, caches identity only within the request, and revokes on logout', async () => {
    const f = fixture()
    const token = opaqueToken()
    const req = request(`knowledgeops_session=${token}`)
    f.tx.session.findUnique.mockResolvedValue({
      expiresAt: new Date(Date.now() + 1000),
      user: f.user,
    })
    await expect(f.auth.requireUser(req)).resolves.toEqual(f.user)
    await f.auth.requireUser(req)
    expect(f.tx.session.findUnique).toHaveBeenCalledTimes(1)
    f.tx.session.findUnique.mockResolvedValue({ expiresAt: new Date(Date.now()), user: f.user })
    await expect(f.auth.requireUser(request(req.headers.cookie))).rejects.toMatchObject({
      status: 401,
    })
    await f.auth.logout(req)
    expect(f.tx.session.deleteMany).toHaveBeenCalledWith({ where: { tokenHash: hashToken(token) } })
    await expect(f.auth.requireUser(request())).rejects.toMatchObject({ status: 401 })
  })

  it('bounds login attempts and never falls back to a development identity', () => {
    const f = fixture()
    for (let i = 0; i < 10; i++) f.begin()
    expect(() => f.begin()).toThrow('Too many login attempts')
    const unconfigured = new AuthService(f.database, readApiEnvironment({}), f.upstream)
    expect(() => unconfigured.beginLogin(request())).toThrow('GitHub login is not configured')
  })
})
