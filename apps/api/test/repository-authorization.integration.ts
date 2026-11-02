import 'reflect-metadata'
import { resolve } from 'node:path'
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module.js'
import { API_ENVIRONMENT } from '../src/config/config.module.js'
import { readApiEnvironment } from '../src/config/environment.js'
import { DatabaseService } from '../src/database/database.service.js'
import { hashToken, opaqueToken } from '../src/identity/auth-http.js'
import { AuthService } from '../src/identity/auth.service.js'
import { GitHubRepositories } from '../src/repositories/github-repositories.js'
import { githubAuthorizationFixture } from './fixtures/github-authorization.js'

const environment = readApiEnvironment({
  ...process.env,
  NODE_ENV: 'test',
  WEB_ORIGIN: 'http://127.0.0.1:3000',
  GITHUB_APP_CLIENT_ID: 'r16-fixture-client',
  GITHUB_APP_CLIENT_SECRET: 'r16-fixture-secret',
  GITHUB_APP_CALLBACK_URL: 'http://127.0.0.1:4000/auth/github/callback',
  GITHUB_APP_PRIVATE_KEY_PATH: resolve('.secrets', 'never-read-r16-fixture.pem'),
})

describe('R16 GitHub authorization: real sessions, permission adapter, HTTP and PostgreSQL', () => {
  const f = githubAuthorizationFixture()
  const database = new DatabaseService(environment.DATABASE_URL)
  const userIds = f.people.map((person) => person.userId)
  const installationIds = f.people.map((person) => String(person.installation.id))
  let app: INestApplication
  let baseUrl: string
  const get = (path: string, cookie: string) => fetch(`${baseUrl}${path}`, { headers: { cookie } })
  const post = (action: string, body: unknown, cookie = f.b.cookie) =>
    fetch(`${baseUrl}/repositories/${action}`, {
      method: 'POST',
      headers: { cookie, origin: environment.WEB_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const rows = async () => ({
    repositories: await database.client.repository.findMany({
      where: { userId: { in: userIds } },
      orderBy: { id: 'asc' },
    }),
    installations: await database.client.gitHubInstallation.findMany({
      where: { id: { in: installationIds } },
      orderBy: { id: 'asc' },
    }),
    versions: await database.client.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, repositoryVersion: true },
      orderBy: { id: 'asc' },
    }),
  })
  const expectNoAppAccess = () => {
    expect(f.loadKey).not.toHaveBeenCalled()
    expect(
      f.upstream.mock.calls.some(([url]) => new URL(String(url)).pathname.startsWith('/app')),
    ).toBe(false)
  }

  beforeAll(async () => {
    // 随机身份先分配 ID，失败清理也只影响这两个用户。
    await database.client.user.createMany({
      data: f.people.map((person) => ({
        id: person.userId,
        githubUserId: String(person.githubId),
      })),
    })
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(API_ENVIRONMENT)
      .useValue(environment)
      .overrideProvider(DatabaseService)
      .useValue(database)
      .overrideProvider(AuthService)
      .useValue(new AuthService(database, environment, f.upstream))
      .overrideProvider(GitHubRepositories)
      .useValue(new GitHubRepositories(environment, f.upstream, f.loadKey))
      .compile()
    app = module.createNestApplication({ logger: false })
    await app.listen(0, '127.0.0.1')
    baseUrl = await app.getUrl()
    for (const person of f.people) {
      // 本地 HTTP 走真实 state/回调/会话建立；不跟随 Location 到真实 GitHub。
      const login = await fetch(`${baseUrl}/auth/github/login`, { redirect: 'manual' })
      expect(login.status).toBe(302)
      const state = new URL(login.headers.get('location')!).searchParams.get('state')!
      const callback = await fetch(
        `${baseUrl}/auth/github/callback?${new URLSearchParams({ state, code: person.code })}`,
        {
          redirect: 'manual',
          headers: { cookie: login.headers.getSetCookie()[0]!.split(';')[0]! },
        },
      )
      expect(callback.headers.get('location')).toBe(`${environment.WEB_ORIGIN}/app/plan`)
      person.cookie = callback.headers
        .getSetCookie()
        .find((cookie) => cookie.startsWith('knowledgeops_session='))!
        .split(';')[0]!
      expect(await (await get('/auth/session', person.cookie)).json()).toMatchObject({
        user: { id: person.userId, githubLogin: person.login },
      })
    }
  })

  beforeEach(async () => {
    await database.client.repository.deleteMany({ where: { userId: { in: userIds } } })
    await database.client.gitHubInstallation.deleteMany({ where: { id: { in: installationIds } } })
    await database.client.user.updateMany({
      where: { id: { in: userIds } },
      data: { repositoryVersion: 0 },
    })
    f.reset()
  })

  afterAll(async () => {
    try {
      await database.client.user.deleteMany({ where: { id: { in: userIds } } })
      await database.client.gitHubInstallation.deleteMany({
        where: { id: { in: installationIds } },
      })
      expect(await database.client.repository.count({ where: { userId: { in: userIds } } })).toBe(0)
      expect(await database.client.session.count({ where: { userId: { in: userIds } } })).toBe(0)
    } finally {
      if (app) await app.close()
      else await database.onApplicationShutdown()
    }
  })

  it('uses each session’s grant; known foreign IDs cannot list, bind or unbind another user’s repository', async () => {
    for (const person of f.people) {
      expect(await (await get('/repositories/installations', person.cookie)).json()).toMatchObject({
        installations: [
          { id: String(person.installation.id), accountLogin: person.installation.account.login },
        ],
      })
      const listed = await get(
        `/repositories/installations/${person.installation.id}`,
        person.cookie,
      )
      expect(listed.status).toBe(200)
      expect((await listed.json()).repositories).toEqual([
        {
          githubRepositoryId: String(person.repository.id),
          fullName: person.repository.full_name,
          defaultBranch: 'main',
          isPrivate: true,
        },
      ])
    }
    f.upstream.mockClear()
    f.loadKey.mockClear()
    const before = await rows()
    expect(
      (await get(`/repositories/installations/${f.a.installation.id}`, f.b.cookie)).status,
    ).toBe(404)
    const forbidden = await post('bind', f.command(f.a))
    const absent = await post('bind', { ...f.command(f.a), installationId: '999' })
    expect(forbidden.status).toBe(404)
    expect(absent.status).toBe(404)
    expect(await forbidden.json()).toEqual(await absent.json())
    expectNoAppAccess()
    expect(await rows()).toEqual(before)

    // 正常绑定对照，避免“全部拒绝”也让隔离测试通过。
    for (const person of f.people) {
      const bound = await post('bind', f.command(person), person.cookie)
      expect(bound.status).toBe(200)
      const snapshot = await bound.json()
      expect(snapshot).toMatchObject({
        version: 1,
        repository: {
          installationId: String(person.installation.id),
          githubRepositoryId: String(person.repository.id),
        },
      })
      expect(await (await get('/repositories/binding', person.cookie)).json()).toEqual(snapshot)
    }
    const bound = await rows()
    for (const person of f.people)
      expect(bound.repositories).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            userId: person.userId,
            githubRepositoryId: String(person.repository.id),
            enabled: true,
          }),
        ]),
      )
    const aBinding = bound.repositories.find((item) => item.userId === f.a.userId)!
    expect((await post('unbind', { repositoryId: aBinding.id, expectedVersion: 1 })).status).toBe(
      404,
    )
    expect(await rows()).toEqual(bound)
  })

  it('rejects a repository outside the user’s scope even when that installation is accessible', async () => {
    f.b.scope.installations.push(f.a.installation.id)
    const options = await get(`/repositories/installations/${f.a.installation.id}`, f.b.cookie)
    expect(options.status).toBe(200)
    expect(await options.json()).toEqual({ repositories: [] })
    const before = await rows()
    expect((await post('bind', f.command(f.a))).status).toBe(404)
    expectNoAppAccess()
    expect(await rows()).toEqual(before)
  })

  it('rechecks permission on POST when an earlier repository option has been revoked', async () => {
    const options = await get(`/repositories/installations/${f.a.installation.id}`, f.a.cookie)
    expect((await options.json()).repositories).toHaveLength(1)
    f.a.scope.repositories = []
    const before = await rows()
    expect((await post('bind', f.command(f.a), f.a.cookie)).status).toBe(404)
    expectNoAppAccess()
    expect(await rows()).toEqual(before)
    expect((await get('/auth/session', f.a.cookie)).status).toBe(200)
  })

  it('does not borrow another session’s GitHub grant when a valid project session has no grant', async () => {
    const token = opaqueToken()
    await database.client.session.create({
      data: {
        userId: f.a.userId,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 3600_000),
      },
    })
    const cookie = `knowledgeops_session=${token}`
    const before = await rows()
    expect((await get('/auth/session', cookie)).status).toBe(200)
    const denied = await post('bind', f.command(f.a), cookie)
    expect(denied.status).toBe(409)
    expect(await denied.json()).toMatchObject({ reason: 'GITHUB_AUTH_REQUIRED' })
    expect(f.upstream).not.toHaveBeenCalled()
    expect(await rows()).toEqual(before)
  })
})
