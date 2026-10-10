import 'reflect-metadata'
import { randomInt, randomUUID } from 'node:crypto'
import { NotFoundException, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppModule } from '../src/app.module.js'
import { API_ENVIRONMENT } from '../src/config/config.module.js'
import { readApiEnvironment } from '../src/config/environment.js'
import { DatabaseService } from '../src/database/database.service.js'
import { hashToken, opaqueToken } from '../src/identity/auth-http.js'
import { AuthService } from '../src/identity/auth.service.js'
import { GitHubRepositories } from '../src/repositories/github-repositories.js'
import { RepositoryBindingService } from '../src/repositories/repository-binding.service.js'
import type { BindRepositoryInput } from '@knowledgeops/contracts'

const environment = readApiEnvironment({
  ...process.env,
  NODE_ENV: 'test',
  WEB_ORIGIN: 'http://127.0.0.1:3000',
})
describe('R04 repository binding: real PostgreSQL and HTTP, synthetic GitHub upstream', () => {
  const database = new DatabaseService(environment.DATABASE_URL)
  const ownerId = randomUUID()
  const otherId = randomUUID()
  const token = opaqueToken()
  const otherToken = opaqueToken()
  const installationId = String(Date.now() * 1000 + Math.floor(Math.random() * 1000))
  const otherInstallationId = String(Number(installationId) + 1)
  const githubRepositoryId = String(randomInt(1_000_000_000_000, 2_000_000_000_000))
  const otherRepositoryId = String(Number(githubRepositoryId) + 1)
  const input = { installationId, githubRepositoryId, expectedVersion: 0 }
  const verify =
    vi.fn<
      (token: string, command: BindRepositoryInput) => ReturnType<GitHubRepositories['verify']>
    >()
  const github = {
    verify,
    installations: vi.fn(),
    repositories: vi.fn(),
  } as unknown as GitHubRepositories
  let app: INestApplication
  let baseUrl: string
  const headers = (session = token) => ({
    cookie: `knowledgeops_session=${session}`,
    origin: environment.WEB_ORIGIN,
    'content-type': 'application/json',
  })
  const post = (action: string, body: unknown, session = token) =>
    fetch(`${baseUrl}/repositories/${action}`, {
      method: 'POST',
      headers: headers(session),
      body: JSON.stringify(body),
    })
  const current = async (session = token) =>
    (await fetch(`${baseUrl}/repositories/binding`, { headers: headers(session) })).json()

  beforeAll(async () => {
    await database.client.user.createMany({
      data: [
        { id: ownerId, githubLogin: 'r04-repository-fixture-owner' },
        { id: otherId, githubLogin: 'r04-repository-fixture-other' },
      ],
    })
    await database.client.session.createMany({
      data: [
        {
          userId: ownerId,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + 3600_000),
        },
        {
          userId: otherId,
          tokenHash: hashToken(otherToken),
          expiresAt: new Date(Date.now() + 3600_000),
        },
      ],
    })
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(API_ENVIRONMENT)
      .useValue(environment)
      .overrideProvider(DatabaseService)
      .useValue(database)
      .overrideProvider(GitHubRepositories)
      .useValue(github)
      .compile()
    app = module.createNestApplication({ logger: false })
    const auth = app.get(AuthService)
    // Only the upstream credential is synthetic. Session lookup, Guard and Origin remain real.
    vi.spyOn(auth, 'requireGitHubToken').mockImplementation(async (request) => {
      await auth.requireUser(request)
      return 'fixture-only-user-token'
    })
    await app.listen(0, '127.0.0.1')
    baseUrl = await app.getUrl()
  })

  beforeEach(async () => {
    await database.client.repository.deleteMany({ where: { userId: { in: [ownerId, otherId] } } })
    await database.client.gitHubInstallation.deleteMany({
      where: { id: { in: [installationId, otherInstallationId] } },
    })
    await database.client.user.updateMany({
      where: { id: { in: [ownerId, otherId] } },
      data: { repositoryVersion: 0 },
    })
    verify.mockReset().mockImplementation(async (_token, command) => {
      if (
        ![installationId, otherInstallationId].includes(command.installationId) ||
        ![githubRepositoryId, otherRepositoryId].includes(command.githubRepositoryId)
      )
        throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND', message: 'Fixture inaccessible' })
      return {
        githubRepositoryId: command.githubRepositoryId,
        fullName: `fixture-owner/notes-${command.githubRepositoryId}`,
        defaultBranch: 'main',
        branch: command.branch ?? 'main',
        isPrivate: true,
        installation: {
          id: command.installationId,
          accountId: '42',
          accountLogin: 'fixture-owner',
        },
      }
    })
  })

  afterAll(async () => {
    try {
      await database.client.user.deleteMany({ where: { id: { in: [ownerId, otherId] } } })
      await database.client.gitHubInstallation.deleteMany({
        where: { id: { in: [installationId, otherInstallationId] } },
      })
    } finally {
      if (app) await app.close()
      else await database.onApplicationShutdown()
    }
  })

  it('protects read and write entrypoints with real sessions and Origin', async () => {
    expect((await fetch(`${baseUrl}/repositories/binding`)).status).toBe(401)
    expect((await fetch(`${baseUrl}/repositories/installations`)).status).toBe(401)
    for (const origin of ['', 'https://untrusted.example']) {
      const response = await fetch(`${baseUrl}/repositories/bind`, {
        method: 'POST',
        headers: { ...headers(), origin },
        body: JSON.stringify(input),
      })
      expect(response.status).toBe(403)
    }
    expect(verify).not.toHaveBeenCalled()
    expect(await current()).toEqual({ version: 0, repository: null })
  })

  it('persists a binding, restores through a new service, and isolates the other user', async () => {
    const response = await post('bind', input)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const saved = await response.json()
    expect(saved).toMatchObject({
      version: 1,
      repository: { installationId, githubRepositoryId, branch: 'main' },
    })
    expect(await current()).toEqual(saved)
    expect(await new RepositoryBindingService(database, github).current(ownerId)).toEqual(saved)
    expect(await current(otherToken)).toEqual({ version: 0, repository: null })
    expect(JSON.stringify(saved)).not.toContain('fixture-only-user-token')
  })

  it('rejects forged IDs and caller-supplied ownership without writing', async () => {
    expect((await post('bind', { ...input, installationId: '999' })).status).toBe(404)
    expect((await post('bind', { ...input, githubRepositoryId: '999' })).status).toBe(404)
    expect((await post('bind', { ...input, userId: otherId })).status).toBe(400)
    expect((await post('bind', { ...input, installationId: '../../app' })).status).toBe(400)
    expect(await current()).toEqual({ version: 0, repository: null })
    expect(await database.client.gitHubInstallation.count({ where: { id: installationId } })).toBe(
      0,
    )
  })

  it('serializes concurrent different bindings to one winner', async () => {
    const responses = await Promise.all([
      post('bind', input),
      post('bind', { ...input, githubRepositoryId: otherRepositoryId }),
    ])
    expect(responses.map((res) => res.status).sort()).toEqual([200, 409])
    expect(
      await database.client.repository.count({ where: { userId: ownerId, enabled: true } }),
    ).toBe(1)
    expect((await current()).version).toBe(1)
  })

  it('returns the same persisted binding for concurrent duplicate submissions', async () => {
    const responses = await Promise.all([post('bind', input), post('bind', input)])
    expect(responses.map((res) => res.status)).toEqual([200, 200])
    expect(await responses[0]!.json()).toEqual(await responses[1]!.json())
    expect(await database.client.repository.count({ where: { userId: ownerId } })).toBe(1)
    expect((await current()).version).toBe(1)
  })

  it('does not implicitly replace a current binding or accept a future version', async () => {
    expect((await post('bind', { ...input, expectedVersion: 1 })).status).toBe(409)
    expect((await post('bind', input)).status).toBe(200)
    expect(
      (await post('bind', { ...input, githubRepositoryId: otherRepositoryId, expectedVersion: 1 }))
        .status,
    ).toBe(409)
    expect((await current()).repository.githubRepositoryId).toBe(githubRepositoryId)
  })

  it('denies foreign unbind and stale version without changing the binding', async () => {
    const saved = await (await post('bind', input)).json()
    const command = { repositoryId: saved.repository.id, expectedVersion: 1 }
    expect((await post('unbind', command, otherToken)).status).toBe(404)
    expect((await post('unbind', { ...command, expectedVersion: 0 })).status).toBe(409)
    expect(await current()).toEqual(saved)
  })

  it('keeps disabled history and rejects delayed bind replay after unbind', async () => {
    const saved = await (await post('bind', input)).json()
    const command = { repositoryId: saved.repository.id, expectedVersion: 1 }
    expect(await (await post('unbind', command)).json()).toEqual({ version: 2, repository: null })
    expect(await (await post('unbind', command)).json()).toEqual({ version: 2, repository: null })
    expect((await post('bind', input)).status).toBe(409)
    const history = await database.client.repository.findUniqueOrThrow({
      where: { id: saved.repository.id },
    })
    expect(history.enabled).toBe(false)
    expect(history.unboundAt).not.toBeNull()
  })

  it('cannot remove a new binding by replaying the old unbind command', async () => {
    const first = await (await post('bind', input)).json()
    const command = { repositoryId: first.repository.id, expectedVersion: 1 }
    await post('unbind', command)
    const second = await (await post('bind', { ...input, expectedVersion: 2 })).json()
    expect(second.repository.id).not.toBe(first.repository.id)
    expect(await (await post('unbind', command)).json()).toEqual(second)
    expect(await current()).toEqual(second)
  })

  it('rolls back installation and version when the repository insert fails', async () => {
    verify.mockResolvedValueOnce({
      githubRepositoryId,
      fullName: 'fixture/notes',
      defaultBranch: 'main',
      branch: 'x'.repeat(256),
      isPrivate: true,
      installation: { id: installationId, accountId: '42', accountLogin: 'fixture-owner' },
    })
    expect((await post('bind', input)).status).toBe(500)
    expect(await current()).toEqual({ version: 0, repository: null })
    expect(await database.client.gitHubInstallation.count({ where: { id: installationId } })).toBe(
      0,
    )
  })

  it('enforces the one-enabled-binding rule even for a writer bypassing the service', async () => {
    const first = await (await post('bind', input)).json()
    await expect(
      database.client.repository.create({
        data: {
          userId: ownerId,
          installationId,
          githubRepositoryId: otherRepositoryId,
          fullName: 'fixture/other',
          defaultBranch: 'main',
          branch: 'main',
          isPrivate: true,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' })
    expect(await current()).toEqual(first)
  })

  it('rejects another user claiming the same repository, even through another branch or installation', async () => {
    const saved = await (await post('bind', input)).json()
    for (const command of [
      { ...input, branch: 'dev' },
      { ...input, installationId: otherInstallationId },
    ]) {
      const response = await post('bind', command, otherToken)
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({
        code: 'CONFLICT',
        message: '该仓库当前无法绑定，请刷新状态或选择其他仓库；已有活动绑定需先解除。',
      })
    }
    expect(await current()).toEqual(saved)
    expect(await current(otherToken)).toEqual({ version: 0, repository: null })
    expect(
      await database.client.gitHubInstallation.count({ where: { id: otherInstallationId } }),
    ).toBe(0)
  })

  it('turns a concurrent cross-user unique-key conflict into 409 after both occupancy checks saw no binding', async () => {
    let checked = 0
    let release!: () => void
    const bothChecked = new Promise<void>((resolve) => {
      release = resolve
    })
    const racedClient = database.client.$extends({
      query: {
        repository: {
          async findFirst({ args, query }) {
            const result = await query(args)
            if (args.where?.githubRepositoryId === githubRepositoryId) {
              expect(result).toBeNull()
              if (++checked === 2) release()
              await bothChecked
            }
            return result
          },
        },
      },
    })
    const raced = new RepositoryBindingService(
      { client: racedClient } as unknown as DatabaseService,
      github,
    )
    const results = await Promise.allSettled([
      raced.bind(ownerId, 'fixture-only', input),
      raced.bind(otherId, 'fixture-only', {
        ...input,
        installationId: otherInstallationId,
        branch: 'dev',
      }),
    ])
    expect(checked).toBe(2)
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const failure = results.find((result) => result.status === 'rejected')
    expect(failure).toMatchObject({ status: 'rejected', reason: { status: 409 } })
    expect(
      await database.client.repository.count({ where: { githubRepositoryId, enabled: true } }),
    ).toBe(1)
    expect(
      await database.client.gitHubInstallation.count({
        where: { id: { in: [installationId, otherInstallationId] } },
      }),
    ).toBe(1)
    const versions = await database.client.user.findMany({
      where: { id: { in: [ownerId, otherId] } },
      select: { repositoryVersion: true },
    })
    expect(versions.map((user) => user.repositoryVersion).sort()).toEqual([0, 1])
  })

  it('releases exclusivity on unbind without moving history or accepting stale unbind against the new owner', async () => {
    const first = await (await post('bind', input)).json()
    const command = { repositoryId: first.repository.id, expectedVersion: 1 }
    expect((await post('unbind', command)).status).toBe(200)
    const response = await post('bind', input, otherToken)
    expect(response.status).toBe(200)
    const second = await response.json()
    expect(second.repository.id).not.toBe(first.repository.id)
    expect(
      await database.client.repository.findUniqueOrThrow({ where: { id: first.repository.id } }),
    ).toMatchObject({ userId: ownerId, enabled: false })
    await post('unbind', command)
    expect(await current()).toEqual({ version: 2, repository: null })
    expect(await current(otherToken)).toEqual(second)
    expect(await database.client.repository.count({ where: { githubRepositoryId } })).toBe(2)
    expect(
      await database.client.repository.count({ where: { githubRepositoryId, enabled: true } }),
    ).toBe(1)
  })

  it('enforces repository exclusivity for direct inserts across installation and branch, but permits disabled history', async () => {
    const first = await (await post('bind', input)).json()
    await database.client.gitHubInstallation.create({
      data: {
        id: otherInstallationId,
        accountId: '43',
        accountLogin: 'fixture-other',
        verifiedAt: new Date(),
      },
    })
    const data = {
      userId: otherId,
      installationId: otherInstallationId,
      githubRepositoryId,
      fullName: 'fixture/notes',
      defaultBranch: 'main',
      branch: 'dev',
      isPrivate: true,
    }
    await expect(database.client.repository.create({ data })).rejects.toMatchObject({
      code: 'P2002',
    })
    const history = await database.client.repository.create({
      data: { ...data, enabled: false, unboundAt: new Date() },
    })
    await expect(
      database.client.repository.update({ where: { id: history.id }, data: { enabled: true } }),
    ).rejects.toMatchObject({ code: 'P2002' })
    expect(await current()).toEqual(first)
    expect(await current(otherToken)).toEqual({ version: 0, repository: null })
  })

  it('still allows different users to bind different repositories', async () => {
    const responses = await Promise.all([
      post('bind', input),
      post('bind', { ...input, githubRepositoryId: otherRepositoryId }, otherToken),
    ])
    expect(responses.map((response) => response.status)).toEqual([200, 200])
    expect((await current()).repository.githubRepositoryId).toBe(githubRepositoryId)
    expect((await current(otherToken)).repository.githubRepositoryId).toBe(otherRepositoryId)
  })
})
