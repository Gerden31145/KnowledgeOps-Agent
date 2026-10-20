import { createHash, generateKeyPairSync, randomInt, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { createDatabaseClient } from '@knowledgeops/database'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readWorkerEnvironment } from '../src/config/environment.js'
import { BoundCommitEvidenceReader } from '../src/github/read-bound-commit-evidence.js'

// 真实 PostgreSQL 绑定筛选 + 真实读取器；GitHub 与私钥为合成替身，不 mint 真实 Token。
describe('R06 bound evidence: real PostgreSQL, synthetic GitHub', () => {
  const database = createDatabaseClient(readWorkerEnvironment().DATABASE_URL)
  const ownerId = randomUUID()
  const otherId = randomUUID()
  const repositoryId = randomUUID()
  const installationId = String(randomInt(2_000_000_000_000, 3_000_000_000_000))
  const githubRepositoryId = String(randomInt(3_000_000_000_000, 4_000_000_000_000))
  const command = {
    repositoryId,
    userId: ownerId,
    repositoryVersion: 3,
    installationId,
    githubRepositoryId,
    ref: 'refs/heads/main',
    beforeCommitSha: 'a'.repeat(40),
    afterCommitSha: 'b'.repeat(40),
    targetPath: 'notes/vue.md',
  }
  const content = '# Vue\nfixture-only\n'
  const bytes = Buffer.from(content)
  const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
  const pem = generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs1', format: 'pem' })
    .toString()
  const loadKey = vi.fn().mockResolvedValue(pem)
  const upstream = vi.fn<typeof fetch>()
  const reader = new BoundCommitEvidenceReader(
    database,
    {
      GITHUB_APP_CLIENT_ID: 'fixture-client',
      GITHUB_APP_PRIVATE_KEY_PATH: resolve('.secrets', 'fixture-only.pem'),
    },
    upstream,
    loadKey,
  )
  const bindingData = (userId = ownerId) => ({
    userId,
    installationId,
    githubRepositoryId,
    fullName: 'fixture-owner/notes',
    defaultBranch: 'main',
    branch: 'main',
    isPrivate: true,
  })
  const unbind = async () => {
    await database.$transaction([
      database.repository.update({
        where: { id: repositoryId },
        data: { enabled: false, unboundAt: new Date() },
      }),
      database.user.update({
        where: { id: ownerId },
        data: { repositoryVersion: { increment: 1 } },
      }),
    ])
  }

  beforeAll(async () => {
    await database.user.createMany({
      data: [
        { id: ownerId, githubLogin: 'r06-evidence-fixture-owner' },
        { id: otherId, githubLogin: 'r06-evidence-fixture-other' },
      ],
    })
    await database.gitHubInstallation.create({
      data: {
        id: installationId,
        accountId: '42',
        accountLogin: 'fixture-owner',
        verifiedAt: new Date(),
      },
    })
  })

  beforeEach(async () => {
    // 只清理本套测试随机 UUID 对应的记录，不扫描或重置用户业务数据。
    await database.repository.deleteMany({ where: { userId: { in: [ownerId, otherId] } } })
    await database.user.updateMany({
      where: { id: { in: [ownerId, otherId] } },
      data: { repositoryVersion: 3 },
    })
    await database.repository.create({ data: { id: repositoryId, ...bindingData() } })
    loadKey.mockClear()
    upstream.mockReset().mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname
      if (path === `/app/installations/${installationId}`)
        return Response.json({
          id: Number(installationId),
          account: { id: 42, login: 'fixture-owner' },
          permissions: { contents: 'read' },
          repository_selection: 'selected',
          suspended_at: null,
        })
      if (path.endsWith('/access_tokens'))
        return Response.json({
          token: 'fixture-only-token',
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        })
      if (path === `/repositories/${githubRepositoryId}`)
        return Response.json({
          id: Number(githubRepositoryId),
          full_name: 'fixture-owner/notes',
        })
      if (path.includes('/compare/'))
        return Response.json({
          base_commit: { sha: command.beforeCommitSha },
          merge_base_commit: { sha: command.beforeCommitSha },
          files: [
            {
              filename: command.targetPath,
              sha,
              status: 'added',
              additions: 2,
              deletions: 0,
              patch: '@@ -0,0 +1,2 @@\n+# Vue\n+fixture-only',
            },
          ],
        })
      if (path.endsWith('/contents/notes/vue.md'))
        return Response.json({
          type: 'file',
          path: command.targetPath,
          sha,
          size: bytes.length,
          encoding: 'base64',
          content: bytes.toString('base64'),
        })
      return new Response(null, { status: 404 })
    })
  })

  afterAll(async () => {
    try {
      await database.user.deleteMany({ where: { id: { in: [ownerId, otherId] } } })
      await database.gitHubInstallation.deleteMany({ where: { id: installationId } })
    } finally {
      await database.$disconnect()
    }
  })

  it('collects pinned evidence with a currently enabled original binding', async () => {
    await expect(reader.read(command)).resolves.toMatchObject({
      status: 'COLLECTED',
      evidence: {
        content,
        sourceCommitSha: command.afterCommitSha,
      },
    })
    expect(upstream).toHaveBeenCalledTimes(5)
  })

  it.each([
    { userId: otherId },
    { repositoryId: randomUUID() },
    { repositoryVersion: 2 },
    { installationId: String(Number(installationId) + 1) },
    { githubRepositoryId: String(Number(githubRepositoryId) + 1) },
    { ref: 'refs/heads/other' },
  ])('does not authorize a mismatched binding snapshot %j', async (change) => {
    await expect(reader.read({ ...command, ...change })).resolves.toEqual({
      status: 'IGNORED',
      reason: 'BINDING_CHANGED',
    })
    expect(loadKey).not.toHaveBeenCalled()
    expect(upstream).not.toHaveBeenCalled()
  })

  it('skips an unbound repository before issuing credentials', async () => {
    await unbind()
    await expect(reader.read(command)).resolves.toEqual({
      status: 'IGNORED',
      reason: 'BINDING_CHANGED',
    })
    expect(upstream).not.toHaveBeenCalled()
  })

  it.each([ownerId, otherId])(
    'does not reroute old work to a replacement binding owned by %s',
    async (userId) => {
      await unbind()
      await database.repository.create({ data: bindingData(userId) })
      await expect(reader.read(command)).resolves.toEqual({
        status: 'IGNORED',
        reason: 'BINDING_CHANGED',
      })
      expect(upstream).not.toHaveBeenCalled()
    },
  )

  it.each([
    { at: '/access_tokens', calls: 2 },
    { at: '/contents/notes/vue.md', calls: 5 },
  ])('discards stale work when unbinding happens during $at', async ({ at, calls }) => {
    const original = upstream.getMockImplementation()!
    upstream.mockImplementation(async (url, init) => {
      if (new URL(String(url)).pathname.endsWith(at)) await unbind()
      return original(url, init)
    })
    await expect(reader.read(command)).resolves.toEqual({
      status: 'IGNORED',
      reason: 'BINDING_CHANGED',
    })
    expect(upstream).toHaveBeenCalledTimes(calls)
  })
})
