import { generateKeyPairSync, randomInt, randomUUID } from 'node:crypto'
import { vi } from 'vitest'

// 只替换外部 GitHub 的 HTTP 响应；会话、Token 选择和 verify() 都执行产品代码。
export function githubAuthorizationFixture() {
  const people = ['a', 'b'].map((name) => {
    const id = randomInt(3_000_000_000_000, 4_000_000_000_000)
    return {
      userId: randomUUID(),
      githubId: id,
      login: `r16-authorization-${name}`,
      code: `fixture-code-${name}`,
      token: `fixture-user-token-${name}`,
      installation: {
        id: id + 1,
        account: { id, login: `fixture-${name}` },
        permissions: { contents: 'read' },
        repository_selection: 'selected',
        suspended_at: null,
      },
      repository: {
        id: id + 2,
        full_name: `fixture-${name}/notes`,
        default_branch: 'main',
        private: true,
      },
      scope: { installations: [] as number[], repositories: [] as number[] },
      cookie: '',
    }
  })
  const [a, b] = people as [(typeof people)[number], (typeof people)[number]]
  const reset = () => {
    for (const person of people) {
      person.scope.installations = [person.installation.id]
      person.scope.repositories = [person.repository.id]
    }
    upstream.mockClear()
    loadKey.mockClear()
  }
  const upstream = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname
    const authorization = new Headers(init?.headers).get('authorization')
    const person = people.find((item) => authorization === `Bearer ${item.token}`)
    if (path === '/login/oauth/access_token') {
      const code = new URLSearchParams(String(init?.body)).get('code')
      const identity = people.find((item) => item.code === code)
      if (identity) return Response.json({ access_token: identity.token, token_type: 'bearer' })
    }
    if (path === '/user' && person)
      return Response.json({ id: person.githubId, login: person.login })
    if (path === '/app') return Response.json({ slug: 'r16-fixture-app' })
    if (path === '/user/installations' && person)
      return Response.json({
        installations: people
          .map((item) => item.installation)
          .filter((item) => person.scope.installations.includes(item.id)),
      })
    for (const owner of people) {
      const installationPath = `/user/installations/${owner.installation.id}/repositories`
      if (path === installationPath && person)
        return Response.json({
          repositories:
            person.scope.installations.includes(owner.installation.id) &&
            person.scope.repositories.includes(owner.repository.id)
              ? [owner.repository]
              : [],
        })
      if (path === `/app/installations/${owner.installation.id}`)
        return Response.json(owner.installation)
      if (path === `/app/installations/${owner.installation.id}/access_tokens`)
        return Response.json({
          token: `fixture-installation-token-${owner.installation.id}`,
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        })
      if (
        path === `/repositories/${owner.repository.id}` &&
        authorization === `Bearer fixture-installation-token-${owner.installation.id}`
      )
        return Response.json(owner.repository)
    }
    throw new Error('Unexpected synthetic GitHub request')
  })
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const loadKey = vi.fn(async () => privateKey.export({ type: 'pkcs1', format: 'pem' }).toString())
  const command = (person: typeof a) => ({
    installationId: String(person.installation.id),
    githubRepositoryId: String(person.repository.id),
    expectedVersion: 0,
  })
  reset()
  return { a, b, people, upstream, loadKey, reset, command }
}
