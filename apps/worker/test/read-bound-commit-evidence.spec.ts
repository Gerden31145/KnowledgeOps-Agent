import { createHash, generateKeyPairSync } from 'node:crypto'
import { resolve } from 'node:path'
import type { DatabaseClient } from '@knowledgeops/database'
import { describe, expect, it, vi } from 'vitest'
import {
  BoundCommitEvidenceReader,
  type ReadBoundCommitEvidenceCommand,
} from '../src/github/read-bound-commit-evidence.js'

// 合成密钥、数据库替身和 GitHub 替身；固定 SHA 读取器、授权函数和 HTTP 适配器是真实实现。
// 不加载 .env，不访问真实私钥、数据库、Redis 或 GitHub。
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const pem = keys.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
const settings = {
  GITHUB_APP_CLIENT_ID: 'fixture-client',
  GITHUB_APP_PRIVATE_KEY_PATH: resolve('.secrets', 'fixture-only.pem'),
}
const command: ReadBoundCommitEvidenceCommand = {
  repositoryId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  repositoryVersion: 3,
  installationId: '10',
  githubRepositoryId: '20',
  ref: 'refs/heads/main',
  beforeCommitSha: 'a'.repeat(40),
  afterCommitSha: 'b'.repeat(40),
  targetPath: 'notes/vue.md',
}
const installation = {
  id: 10,
  account: { id: 42, login: 'fixture-owner' },
  permissions: { contents: 'read' },
  repository_selection: 'selected',
  suspended_at: null,
}
const token = 'fixture-only-installation-token-not-a-real-secret'
const content = '# Vue\n响应式笔记\n'
const bytes = Buffer.from(content)
const blobSha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
const comparison = {
  base_commit: { sha: command.beforeCommitSha },
  merge_base_commit: { sha: command.beforeCommitSha },
  files: [
    {
      filename: command.targetPath,
      sha: blobSha,
      status: 'added',
      additions: 2,
      deletions: 0,
      patch: '@@ -0,0 +1,2 @@\n+# Vue\n+响应式笔记',
    },
  ],
}

function fixture() {
  const findFirst = vi.fn().mockResolvedValue({ id: command.repositoryId })
  const database = { repository: { findFirst } } as unknown as Pick<DatabaseClient, 'repository'>
  const upstream = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    const path = new URL(String(url)).pathname
    if (path === '/app/installations/10') return Response.json(installation)
    if (path === '/app/installations/10/access_tokens')
      return Response.json({
        token,
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      })
    if (path === '/repositories/20')
      return Response.json({ id: 20, full_name: 'fixture-owner/notes' })
    if (path.startsWith('/repos/fixture-owner/notes/compare/')) return Response.json(comparison)
    if (path === '/repos/fixture-owner/notes/contents/notes/vue.md')
      return Response.json({
        type: 'file',
        path: command.targetPath,
        sha: blobSha,
        size: bytes.length,
        encoding: 'base64',
        content: bytes.toString('base64'),
      })
    return new Response('FIXTURE_ONLY_PRIVATE_ERROR', { status: 404 })
  })
  const loadKey = vi.fn().mockResolvedValue(pem)
  return {
    database,
    findFirst,
    upstream,
    loadKey,
    reader: new BoundCommitEvidenceReader(database, settings, upstream, loadKey),
  }
}

describe('R06 bound commit evidence authorization', () => {
  it('uses App JWT for installation authorization, then a single-repository read-only token for fixed-SHA evidence', async () => {
    const f = fixture()
    const result = await f.reader.read(command)
    expect(result).toMatchObject({
      status: 'COLLECTED',
      evidence: {
        content,
        sourceCommitSha: command.afterCommitSha,
        targetPath: command.targetPath,
        change: 'added',
        lineCount: 2,
      },
    })
    expect(f.findFirst).toHaveBeenCalledTimes(3)
    for (const [query] of f.findFirst.mock.calls)
      expect(query).toEqual({
        where: {
          id: command.repositoryId,
          userId: command.userId,
          enabled: true,
          installationId: '10',
          githubRepositoryId: '20',
          branch: 'main',
          user: { repositoryVersion: 3 },
        },
        select: { id: true },
      })
    expect(f.upstream.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/app/installations/10',
      '/app/installations/10/access_tokens',
      '/repositories/20',
      `/repos/fixture-owner/notes/compare/${command.beforeCommitSha}...${command.afterCommitSha}`,
      '/repos/fixture-owner/notes/contents/notes/vue.md',
    ])
    const jwt = new Headers(f.upstream.mock.calls[0]![1]!.headers).get('authorization')!
    expect(jwt).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/)
    expect(new Headers(f.upstream.mock.calls[1]![1]!.headers).get('authorization')).toBe(jwt)
    expect(f.upstream.mock.calls[1]![1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({
        repository_ids: [20],
        permissions: { contents: 'read', metadata: 'read' },
      }),
    })
    for (const [, init] of f.upstream.mock.calls.slice(2)) {
      expect(init?.method).toBe('GET')
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`)
    }
    for (const [url, init] of f.upstream.mock.calls) {
      expect(new URL(String(url)).origin).toBe('https://api.github.com')
      expect(init).toMatchObject({ signal: expect.any(AbortSignal), redirect: 'error' })
      expect(new Headers(init?.headers).has('cookie')).toBe(false)
    }
    expect(new URL(String(f.upstream.mock.calls[4]![0])).searchParams.get('ref')).toBe(
      command.afterCommitSha,
    )
    expect(JSON.stringify(result)).not.toContain(token)
    expect(JSON.stringify(result)).not.toContain(jwt)
    expect(JSON.stringify(result)).not.toContain(pem)
  })

  it('skips an absent, disabled or changed original binding before loading credentials or calling GitHub', async () => {
    const f = fixture()
    f.findFirst.mockResolvedValue(null)
    await expect(f.reader.read(command)).resolves.toEqual({
      status: 'IGNORED',
      reason: 'BINDING_CHANGED',
    })
    expect(f.findFirst).toHaveBeenCalledTimes(1)
    expect(f.loadKey).not.toHaveBeenCalled()
    expect(f.upstream).not.toHaveBeenCalled()
  })

  it('rechecks after minting the token and does not read repository content if unbound meanwhile', async () => {
    const f = fixture()
    f.findFirst.mockResolvedValueOnce({ id: command.repositoryId }).mockResolvedValueOnce(null)
    await expect(f.reader.read(command)).resolves.toEqual({
      status: 'IGNORED',
      reason: 'BINDING_CHANGED',
    })
    expect(f.upstream).toHaveBeenCalledTimes(2)
    expect(f.findFirst).toHaveBeenCalledTimes(2)
  })

  it('discards already-read evidence if the binding changes during GitHub content retrieval', async () => {
    const f = fixture()
    f.findFirst
      .mockResolvedValueOnce({ id: command.repositoryId })
      .mockResolvedValueOnce({ id: command.repositoryId })
      .mockResolvedValueOnce(null)
    await expect(f.reader.read(command)).resolves.toEqual({
      status: 'IGNORED',
      reason: 'BINDING_CHANGED',
    })
    expect(f.upstream).toHaveBeenCalledTimes(5)
    expect(f.findFirst).toHaveBeenCalledTimes(3)
  })

  it('gets a fresh installation token for each read without consulting a user session', async () => {
    const f = fixture()
    await f.reader.read(command)
    await f.reader.read(command)
    expect(
      f.upstream.mock.calls.filter(([url]) => String(url).endsWith('/access_tokens')),
    ).toHaveLength(2)
    expect(
      f.upstream.mock.calls.some(([url]) => new URL(String(url)).pathname.startsWith('/user')),
    ).toBe(false)
  })

  it.each([
    { id: 999 },
    { suspended_at: '2026-10-13T00:00:00Z' },
    { permissions: {} },
    { permissions: { contents: 'write' } },
    { repository_selection: 'all' },
  ])('refuses invalid or overbroad installation %j before token issuance', async (change) => {
    const f = fixture()
    f.upstream.mockResolvedValueOnce(Response.json({ ...installation, ...change }))
    await expect(f.reader.read(command)).rejects.toMatchObject({ code: 'GITHUB_AUTH_REQUIRED' })
    expect(f.upstream).toHaveBeenCalledTimes(1)
  })

  it.each([-1000, 10_000])(
    'refuses a token expiring in %i ms without reading repository content',
    async (ttl) => {
      const f = fixture()
      f.upstream.mockResolvedValueOnce(Response.json(installation)).mockResolvedValueOnce(
        Response.json({
          token,
          expires_at: new Date(Date.now() + ttl).toISOString(),
        }),
      )
      await expect(f.reader.read(command)).rejects.toMatchObject({ code: 'GITHUB_UNAVAILABLE' })
      expect(f.upstream).toHaveBeenCalledTimes(2)
    },
  )

  it.each([
    { status: 401, code: 'GITHUB_AUTH_REQUIRED' },
    { status: 403, code: 'GITHUB_UNAVAILABLE' },
    { status: 404, code: 'SOURCE_UNAVAILABLE' },
    { status: 422, code: 'GITHUB_UNAVAILABLE' },
  ])(
    'stops safely when token issuance returns $status; never retries with broader scope',
    async ({ status, code }) => {
      const f = fixture()
      f.upstream
        .mockResolvedValueOnce(Response.json(installation))
        .mockResolvedValueOnce(new Response(`FIXTURE_ONLY_PRIVATE_ERROR ${token}`, { status }))
      const reading = f.reader.read(command)
      await expect(reading).rejects.toMatchObject({
        code,
        message: code,
      })
      await expect(reading).rejects.not.toHaveProperty('cause')
      expect(f.upstream).toHaveBeenCalledTimes(2)
    },
  )

  it.each([{ token: 'bad token' }, { expires_at: 'bad-date' }])(
    'rejects malformed token response %j',
    async (change) => {
      const f = fixture()
      f.upstream.mockResolvedValueOnce(Response.json(installation)).mockResolvedValueOnce(
        Response.json({
          token,
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          ...change,
        }),
      )
      await expect(f.reader.read(command)).rejects.toMatchObject({
        code: 'INVALID_GITHUB_RESPONSE',
      })
      expect(f.upstream).toHaveBeenCalledTimes(2)
    },
  )

  it('fails closed with missing settings or invalid keys without leaking key-loader errors', async () => {
    const f = fixture()
    const unconfigured = new BoundCommitEvidenceReader(f.database, {}, f.upstream, f.loadKey)
    await expect(unconfigured.read(command)).rejects.toMatchObject({ code: 'GITHUB_UNAVAILABLE' })
    expect(f.loadKey).not.toHaveBeenCalled()
    f.loadKey.mockRejectedValueOnce(new Error('FIXTURE_ONLY_PRIVATE_KEY_PATH'))
    const reading = f.reader.read(command)
    await expect(reading).rejects.toMatchObject({
      code: 'GITHUB_UNAVAILABLE',
    })
    await expect(reading).rejects.not.toHaveProperty('cause')
    f.loadKey.mockResolvedValueOnce('FIXTURE_ONLY_INVALID_PEM')
    await expect(f.reader.read(command)).rejects.toMatchObject({ code: 'GITHUB_UNAVAILABLE' })
    expect(f.upstream).not.toHaveBeenCalled()
  })

  it.each([
    { repositoryId: 'not-a-uuid' },
    { repositoryVersion: -1 },
    { installationId: '10/../../other' },
    { githubRepositoryId: '9007199254740992' },
    { ref: 'refs/tags/main' },
    { targetPath: '../private.md' },
    { afterCommitSha: 'main' },
  ])('rejects invalid commands before any I/O %j', async (change) => {
    const f = fixture()
    await expect(f.reader.read({ ...command, ...change })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
    expect(f.findFirst).not.toHaveBeenCalled()
    expect(f.loadKey).not.toHaveBeenCalled()
    expect(f.upstream).not.toHaveBeenCalled()
  })

  it('keeps reader IGNORED results instead of treating an unrelated change as evidence', async () => {
    const f = fixture()
    const original = f.upstream.getMockImplementation()!
    f.upstream.mockImplementation(async (url, init) =>
      String(url).includes('/compare/')
        ? Response.json({ ...comparison, files: [] })
        : original(url, init),
    )
    await expect(f.reader.read(command)).resolves.toEqual({
      status: 'IGNORED',
      reason: 'NO_MARKDOWN_CHANGE',
    })
    expect(f.upstream).toHaveBeenCalledTimes(4)
  })
})
