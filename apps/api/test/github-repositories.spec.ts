import { generateKeyPairSync, verify } from 'node:crypto'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { readApiEnvironment } from '../src/config/environment.js'
import { GitHubRepositories } from '../src/repositories/github-repositories.js'

const environment = readApiEnvironment({
  GITHUB_APP_CLIENT_ID: 'fixture-client',
  GITHUB_APP_PRIVATE_KEY_PATH: resolve('.secrets', 'fixture.pem'),
})
// In-memory synthetic key only. No real environment, file, GitHub call or token snapshot.
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const pem = keys.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
const installation = {
  id: 10,
  account: { id: 42, login: 'fixture-owner' },
  permissions: { contents: 'read' },
  repository_selection: 'selected',
  suspended_at: null,
}
const repository = {
  id: 20,
  full_name: 'fixture-owner/notes',
  default_branch: 'main',
  private: true,
}
const input = { installationId: '10', githubRepositoryId: '20', expectedVersion: 0 }
function fixture() {
  const upstream = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    const path = new URL(String(url)).pathname
    if (path === '/app') return Response.json({ slug: 'fixture-app' })
    if (path === '/user/installations') return Response.json({ installations: [installation] })
    if (path === '/user/installations/10/repositories')
      return Response.json({ repositories: [repository] })
    if (path === '/app/installations/10') return Response.json(installation)
    if (path === '/app/installations/10/access_tokens')
      return Response.json({
        token: 'fixture-installation-token',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      })
    if (path === '/repositories/20') return Response.json(repository)
    if (path === '/repos/fixture-owner/notes/branches/feature%2Fnotes')
      return Response.json({ name: 'feature/notes' })
    return Response.json({ message: 'FIXTURE_ONLY_PRIVATE_ERROR' }, { status: 404 })
  })
  const loadKey = vi.fn().mockResolvedValue(pem)
  return { upstream, loadKey, github: new GitHubRepositories(environment, upstream, loadKey) }
}

describe('GitHub repository authorization adapter', () => {
  it('signs short-lived RS256 app credentials and returns only install metadata', async () => {
    const f = fixture()
    expect(await f.github.installations('fixture-user-token')).toEqual({
      installUrl: 'https://github.com/apps/fixture-app/installations/new',
      installations: [{ id: '10', accountLogin: 'fixture-owner' }],
    })
    const header = new Headers(f.upstream.mock.calls[0]![1]!.headers)
    const token = header.get('authorization')!.slice(7)
    const [first, second, signature] = token.split('.') as [string, string, string]
    expect(JSON.parse(Buffer.from(first, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    })
    const claims = JSON.parse(Buffer.from(second, 'base64url').toString())
    expect(claims.iss).toBe('fixture-client')
    expect(claims.exp - claims.iat).toBe(360)
    expect(
      verify(
        'RSA-SHA256',
        Buffer.from(`${first}.${second}`),
        keys.publicKey,
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true)
    for (const [url, init] of f.upstream.mock.calls) {
      expect(new URL(String(url)).origin).toBe('https://api.github.com')
      expect(init).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) })
    }
  })

  it('checks user access first and mints a single-repository read-only installation token', async () => {
    const f = fixture()
    expect(await f.github.verify('fixture-user-token', input)).toEqual({
      githubRepositoryId: '20',
      fullName: 'fixture-owner/notes',
      defaultBranch: 'main',
      branch: 'main',
      isPrivate: true,
      installation: { id: '10', accountId: '42', accountLogin: 'fixture-owner' },
    })
    expect(f.upstream.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/user/installations',
      '/user/installations/10/repositories',
      '/app/installations/10',
      '/app/installations/10/access_tokens',
      '/repositories/20',
    ])
    expect(JSON.parse(String(f.upstream.mock.calls[3]![1]!.body))).toEqual({
      repository_ids: [20],
      permissions: { contents: 'read', metadata: 'read' },
    })
  })

  it('rejects forged installations before key loading or repository discovery', async () => {
    const f = fixture()
    await expect(
      f.github.verify('fixture-user-token', { ...input, installationId: '999' }),
    ).rejects.toMatchObject({ status: 404 })
    expect(f.upstream).toHaveBeenCalledTimes(1)
    expect(f.loadKey).not.toHaveBeenCalled()
  })

  it('rejects even a public repository absent from the user/installation intersection', async () => {
    const f = fixture()
    await expect(
      f.github.verify('fixture-user-token', { ...input, githubRepositoryId: '999' }),
    ).rejects.toMatchObject({ status: 404 })
    expect(f.upstream).toHaveBeenCalledTimes(2)
    expect(f.loadKey).not.toHaveBeenCalled()
  })

  it.each([
    { suspended_at: '2026-09-10T00:00:00Z' },
    { permissions: { contents: 'write' } },
    { permissions: {} },
    { repository_selection: 'all' },
  ])('rejects unavailable or overbroad installation %j', async (change) => {
    const f = fixture()
    f.upstream.mockResolvedValueOnce(
      Response.json({ installations: [{ ...installation, ...change }] }),
    )
    await expect(f.github.verify('fixture-user-token', input)).rejects.toMatchObject({
      status: 404,
    })
    expect(f.loadKey).not.toHaveBeenCalled()
  })

  it('checks a custom branch with a safely encoded path', async () => {
    const f = fixture()
    expect(
      (await f.github.verify('fixture-user-token', { ...input, branch: 'feature/notes' })).branch,
    ).toBe('feature/notes')
    await expect(
      f.github.verify('fixture-user-token', { ...input, branch: 'missing' }),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('does not silently truncate paginated repositories', async () => {
    const f = fixture()
    f.upstream
      .mockResolvedValueOnce(Response.json({ installations: [installation] }))
      .mockResolvedValueOnce(
        Response.json({
          repositories: Array.from({ length: 100 }, (_, i) => ({ ...repository, id: 100 + i })),
        }),
      )
      .mockResolvedValueOnce(Response.json({ repositories: [repository] }))
    expect((await f.github.repositories('fixture-user-token', '10')).repositories).toHaveLength(101)
    expect(String(f.upstream.mock.calls[2]![0])).toContain('page=2')
  })

  it('fails safely on revocation, bad responses, timeouts and invalid keys', async () => {
    const f = fixture()
    f.upstream.mockResolvedValueOnce(new Response(null, { status: 401 }))
    await expect(f.github.repositories('fixture-user-token', '10')).rejects.toMatchObject({
      response: { reason: 'GITHUB_AUTH_REQUIRED' },
    })
    for (const failure of [
      Response.json({ installations: 'FIXTURE_ONLY_PRIVATE_ERROR' }),
      new Response('FIXTURE_ONLY_PRIVATE_ERROR', { status: 403 }),
    ]) {
      f.upstream.mockResolvedValueOnce(failure)
      await expect(f.github.repositories('fixture-user-token', '10')).rejects.toMatchObject({
        status: 503,
      })
    }
    f.upstream.mockRejectedValueOnce(new Error('FIXTURE_ONLY_PRIVATE_ERROR'))
    await expect(f.github.repositories('fixture-user-token', '10')).rejects.not.toThrow(
      'FIXTURE_ONLY_PRIVATE_ERROR',
    )
    f.loadKey.mockResolvedValueOnce('FIXTURE_ONLY_INVALID_PEM')
    await expect(f.github.installations('fixture-user-token')).rejects.toMatchObject({
      status: 503,
    })
  })
})
