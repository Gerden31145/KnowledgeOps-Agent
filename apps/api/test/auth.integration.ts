import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { AppModule } from '../src/app.module.js'
import { API_ENVIRONMENT } from '../src/config/config.module.js'
import { readApiEnvironment } from '../src/config/environment.js'
import { DatabaseService } from '../src/database/database.service.js'
import { hashToken, opaqueToken, type AuthRequest } from '../src/identity/auth-http.js'
import { AuthService } from '../src/identity/auth.service.js'

const environment = readApiEnvironment({
  ...process.env,
  NODE_ENV: 'test',
  WEB_ORIGIN: 'http://127.0.0.1:3000',
  GITHUB_APP_CLIENT_ID: 'test-client',
  GITHUB_APP_CLIENT_SECRET: 'test-secret',
  GITHUB_APP_CALLBACK_URL: 'http://127.0.0.1:4000/auth/github/callback',
})
const request = (cookie?: string) =>
  ({ headers: cookie ? { cookie } : {}, socket: { remoteAddress: '127.0.0.1' } }) as AuthRequest

describe('R04 database sessions and authenticated HTTP ownership', () => {
  const database = new DatabaseService(environment.DATABASE_URL)
  // Synthetic identities only; cleanup is confined to these exact UUIDs.
  const ownerId = randomUUID()
  const otherId = randomUUID()
  const goalId = randomUUID()
  const ownerToken = opaqueToken()
  const otherToken = opaqueToken()
  const expiredToken = opaqueToken()
  const githubId = String(Date.now() * 1000 + Math.floor(Math.random() * 1000))
  let app: INestApplication
  let baseUrl: string

  beforeAll(async () => {
    await database.client.user.createMany({
      data: [
        { id: ownerId, githubUserId: githubId, githubLogin: 'r04-fixture-owner' },
        { id: otherId, githubLogin: 'r04-fixture-other' },
      ],
    })
    await database.client.session.createMany({
      data: [
        {
          tokenHash: hashToken(ownerToken),
          userId: ownerId,
          expiresAt: new Date(Date.now() + 120_000),
        },
        {
          tokenHash: hashToken(otherToken),
          userId: otherId,
          expiresAt: new Date(Date.now() + 120_000),
        },
        {
          tokenHash: hashToken(expiredToken),
          userId: ownerId,
          expiresAt: new Date(Date.now() - 1),
        },
      ],
    })
    await database.client.learningGoal.create({
      data: {
        id: goalId,
        userId: ownerId,
        title: 'R04 fixture',
        currentLevel: 'fixture',
        weeklyMinutes: 120,
        deadline: new Date('2026-09-30'),
      },
    })
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(API_ENVIRONMENT)
      .useValue(environment)
      .overrideProvider(DatabaseService)
      .useValue(database)
      .compile()
    app = module.createNestApplication({ logger: false })
    app.enableCors({ origin: environment.WEB_ORIGIN, credentials: true })
    await app.listen(0, '127.0.0.1')
    baseUrl = await app.getUrl()
  })

  afterAll(async () => {
    try {
      await database.client.learningGoal.deleteMany({ where: { id: goalId } })
      await database.client.user.deleteMany({ where: { id: { in: [ownerId, otherId] } } })
    } finally {
      if (app) await app.close()
      else await database.onApplicationShutdown()
    }
  })

  const headers = (token: string) => ({
    cookie: `knowledgeops_session=${token}`,
    origin: environment.WEB_ORIGIN,
  })

  it('keeps public health available while private routes reject anonymous, forged and expired cookies', async () => {
    expect((await fetch(`${baseUrl}/health/live`)).status).toBe(200)
    for (const path of ['/auth/session', '/tasks/today', '/plan-generation-models']) {
      for (const token of ['', opaqueToken(), expiredToken]) {
        expect((await fetch(`${baseUrl}${path}`, { headers: headers(token) })).status).toBe(401)
      }
    }
  })

  it('recovers persisted sessions through a new service instance and the real HTTP entry', async () => {
    await expect(
      new AuthService(database, environment).requireUser(
        request(`knowledgeops_session=${ownerToken}`),
      ),
    ).resolves.toMatchObject({ id: ownerId })
    const response = await fetch(`${baseUrl}/auth/session`, { headers: headers(ownerToken) })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      user: { id: ownerId, githubLogin: 'r04-fixture-owner', timezone: 'Asia/Shanghai' },
    })
    expect((await fetch(`${baseUrl}/tasks/today`, { headers: headers(ownerToken) })).status).toBe(
      200,
    )
  })

  it('uses the request actor and conceals whether a goal belongs to another user', async () => {
    const invoke = (id: string) =>
      fetch(`${baseUrl}/learning-goals/${id}/plan-generation-runs`, {
        method: 'POST',
        headers: { ...headers(otherToken), 'content-type': 'application/json' },
        body: JSON.stringify({ modelId: environment.PLAN_GENERATION_MODELS_JSON[0]!.id }),
      })
    const foreign = await invoke(goalId)
    const missing = await invoke(randomUUID())
    expect(foreign.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(await foreign.json()).toEqual(await missing.json())
    expect(await database.client.planGenerationRun.count({ where: { goalId } })).toBe(0)
  })

  it('rejects cross-origin or missing-origin mutations even with a valid cookie', async () => {
    for (const origin of [undefined, 'https://untrusted.example']) {
      const response = await fetch(`${baseUrl}/auth/logout`, {
        method: 'POST',
        headers: { cookie: `knowledgeops_session=${ownerToken}`, ...(origin ? { origin } : {}) },
      })
      expect(response.status).toBe(403)
    }
    expect((await fetch(`${baseUrl}/auth/session`, { headers: headers(ownerToken) })).status).toBe(
      200,
    )
  })

  it('reuses the verified GitHub user and rotates the previous session in PostgreSQL', async () => {
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ access_token: 'fixture-token', token_type: 'bearer' }))
      .mockResolvedValueOnce(Response.json({ id: Number(githubId), login: 'r04-fixture-renamed' }))
    const auth = new AuthService(database, environment, upstream)
    const attempt = auth.beginLogin(request())
    const state = new URL(attempt.location).searchParams.get('state')!
    const newCookie = await auth.completeLogin(
      { state, code: 'fixture-code' },
      request(`${attempt.cookie.split(';')[0]}; knowledgeops_session=${ownerToken}`),
    )
    expect(await database.client.user.count({ where: { githubUserId: githubId } })).toBe(1)
    expect(
      await database.client.session.findUnique({ where: { tokenHash: hashToken(ownerToken) } }),
    ).toBeNull()
    await expect(
      new AuthService(database, environment).requireUser(request(newCookie)),
    ).resolves.toMatchObject({ id: ownerId, githubLogin: 'r04-fixture-renamed' })
  })

  it('rolls back a user update if the session insert fails inside the real transaction', async () => {
    const before = await database.client.user.findUniqueOrThrow({ where: { id: ownerId } })
    // Force an FK failure for synthetic data only, without altering the product schema.
    const failingDatabase = {
      client: {
        $transaction: (work: (tx: unknown) => Promise<unknown>) =>
          database.client.$transaction(async (tx) =>
            work({
              user: tx.user,
              session: {
                deleteMany: tx.session.deleteMany.bind(tx.session),
                create: () =>
                  tx.session.create({
                    data: {
                      tokenHash: hashToken(opaqueToken()),
                      userId: randomUUID(),
                      expiresAt: new Date(),
                    },
                  }),
              },
            }),
          ),
      },
    } as unknown as DatabaseService
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ access_token: 'fixture-token', token_type: 'bearer' }))
      .mockResolvedValueOnce(Response.json({ id: Number(githubId), login: 'should-roll-back' }))
    const auth = new AuthService(failingDatabase, environment, upstream)
    const attempt = auth.beginLogin(request())
    await expect(
      auth.completeLogin(
        { state: new URL(attempt.location).searchParams.get('state'), code: 'fixture-code' },
        request(attempt.cookie.split(';')[0]),
      ),
    ).rejects.toMatchObject({ reason: 'session-unavailable' })
    expect(
      (await database.client.user.findUniqueOrThrow({ where: { id: ownerId } })).githubLogin,
    ).toBe(before.githubLogin)
  })

  it('deletes the server session on logout, so replaying the old Cookie is unauthorized', async () => {
    const response = await fetch(`${baseUrl}/auth/logout`, {
      method: 'POST',
      headers: headers(otherToken),
    })
    expect(response.status).toBe(204)
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
    expect((await fetch(`${baseUrl}/auth/session`, { headers: headers(otherToken) })).status).toBe(
      401,
    )
    expect(
      (await fetch(`${baseUrl}/auth/logout`, { method: 'POST', headers: headers(otherToken) }))
        .status,
    ).toBe(204)
  })
})
