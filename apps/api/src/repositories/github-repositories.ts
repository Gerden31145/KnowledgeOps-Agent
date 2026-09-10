import { createPrivateKey, sign } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
  ConflictException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common'
import { z } from 'zod'
import type { BindRepositoryInput, RepositoryOptionsResponse } from '@knowledgeops/contracts'
import type { ApiEnvironment } from '../config/environment.js'

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const installationSchema = z.object({
  id,
  account: z.object({ id, login: z.string().min(1).max(100) }),
  permissions: z.object({ contents: z.string().optional() }),
  repository_selection: z.enum(['all', 'selected']),
  suspended_at: z.string().nullable(),
})
const repositorySchema = z.object({
  id,
  full_name: z.string().min(3).max(220),
  default_branch: z.string().min(1).max(255),
  private: z.boolean(),
})
const appSchema = z.object({ slug: z.string().regex(/^[a-z0-9-]+$/) })
const toOption = (repo: z.infer<typeof repositorySchema>) => ({
  githubRepositoryId: String(repo.id),
  fullName: repo.full_name,
  defaultBranch: repo.default_branch,
  isPrivate: repo.private,
})
const unavailable = () =>
  new ServiceUnavailableException({
    code: 'DEPENDENCY_UNAVAILABLE',
    message: 'GitHub 暂不可用或应用凭据未就绪，请稍后重试。',
  })
const notAuthorized = () =>
  new NotFoundException({
    code: 'RESOURCE_NOT_FOUND',
    message: '仓库或安装当前不可访问，请核对 GitHub 授权。',
  })

// 固定 GitHub 主机、限时请求、只取所需字段；不返回或记录任何上游原文/令牌。
export class GitHubRepositories {
  constructor(
    private readonly environment: ApiEnvironment,
    private readonly fetchGitHub: typeof fetch = fetch,
    private readonly loadKey: (path: string) => Promise<string> = (path) => readFile(path, 'utf8'),
  ) {}

  async installations(userToken: string) {
    const signal = AbortSignal.timeout(20_000)
    const app = await this.request('/app', await this.appToken(), appSchema, signal)
    const installations = await this.pages(
      '/user/installations',
      'installations',
      installationSchema,
      userToken,
      signal,
    )
    return {
      installUrl: `https://github.com/apps/${app.slug}/installations/new`,
      installations: installations
        .filter((item) => this.usable(item))
        .map((item) => ({
          id: String(item.id),
          accountLogin: item.account.login,
        })),
    }
  }

  async repositories(
    userToken: string,
    installationId: string,
  ): Promise<RepositoryOptionsResponse> {
    const signal = AbortSignal.timeout(20_000)
    await this.requireInstallation(userToken, installationId, signal)
    const repositories = await this.pages(
      `/user/installations/${installationId}/repositories`,
      'repositories',
      repositorySchema,
      userToken,
      signal,
    )
    return { repositories: repositories.map(toOption) }
  }

  async verify(userToken: string, input: BindRepositoryInput) {
    const signal = AbortSignal.timeout(20_000)
    // 必须先证明当前用户有权访问该安装，再查用户与安装共同可访问的仓库。
    await this.requireInstallation(userToken, input.installationId, signal)
    const repositories = await this.pages(
      `/user/installations/${input.installationId}/repositories`,
      'repositories',
      repositorySchema,
      userToken,
      signal,
    )
    if (!repositories.some((repo) => String(repo.id) === input.githubRepositoryId))
      throw notAuthorized()

    const appToken = await this.appToken()
    const installation = await this.request(
      `/app/installations/${input.installationId}`,
      appToken,
      installationSchema,
      signal,
    )
    if (String(installation.id) !== input.installationId || !this.usable(installation))
      throw notAuthorized()
    // 显式收窄：只有所选一个仓库，且只读。不落库、不发送给浏览器。
    const access = await this.request(
      `/app/installations/${input.installationId}/access_tokens`,
      appToken,
      z.object({ token: z.string().min(1), expires_at: z.iso.datetime() }),
      signal,
      {
        repository_ids: [Number(input.githubRepositoryId)],
        permissions: { contents: 'read', metadata: 'read' },
      },
    )
    if (new Date(access.expires_at).getTime() <= Date.now()) throw unavailable()
    const repository = await this.request(
      `/repositories/${input.githubRepositoryId}`,
      access.token,
      repositorySchema,
      signal,
    )
    if (String(repository.id) !== input.githubRepositoryId) throw notAuthorized()
    const branch = input.branch ?? repository.default_branch
    if (input.branch) {
      const [owner, name, extra] = repository.full_name.split('/')
      if (!owner || !name || extra) throw unavailable()
      const result = await this.request(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branches/${encodeURIComponent(branch)}`,
        access.token,
        z.object({ name: z.string() }),
        signal,
      )
      if (result.name !== branch) throw notAuthorized()
    }
    return {
      ...toOption(repository),
      branch,
      installation: {
        id: input.installationId,
        accountId: String(installation.account.id),
        accountLogin: installation.account.login,
      },
    }
  }

  private usable(item: z.infer<typeof installationSchema>) {
    return (
      item.suspended_at === null &&
      item.permissions.contents === 'read' &&
      item.repository_selection === 'selected'
    )
  }

  private async requireInstallation(
    userToken: string,
    installationId: string,
    signal: AbortSignal,
  ) {
    const installations = await this.pages(
      '/user/installations',
      'installations',
      installationSchema,
      userToken,
      signal,
    )
    if (!installations.some((item) => String(item.id) === installationId && this.usable(item)))
      throw notAuthorized()
  }

  private async appToken(): Promise<string> {
    try {
      const path = this.environment.GITHUB_APP_PRIVATE_KEY_PATH
      const issuer = this.environment.GITHUB_APP_CLIENT_ID
      if (!path || !issuer) throw unavailable()
      const key = createPrivateKey(await this.loadKey(path))
      if (key.asymmetricKeyType !== 'rsa') throw unavailable()
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
      const now = Math.floor(Date.now() / 1000)
      const input = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: issuer, iat: now - 60, exp: now + 300 })}`
      return `${input}.${sign('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`
    } catch {
      throw unavailable()
    }
  }

  private async pages<T>(
    path: string,
    field: string,
    item: z.ZodType<T>,
    token: string,
    signal: AbortSignal,
  ): Promise<T[]> {
    const result: T[] = []
    for (let page = 1; page <= 10; page += 1) {
      const body = await this.request(
        `${path}?per_page=100&page=${page}`,
        token,
        z.record(z.string(), z.unknown()),
        signal,
      )
      const parsed = z.array(item).safeParse(body[field])
      if (!parsed.success) throw unavailable()
      result.push(...parsed.data)
      if (parsed.data.length < 100) return result
    }
    // 有限扫描失败时不返回截断列表，避免把“未加载”误判成“未授权”。
    throw unavailable()
  }

  private async request<T>(
    path: string,
    token: string,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<T> {
    try {
      const response = await this.fetchGitHub(`https://api.github.com${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'user-agent': 'KnowledgeOps-Agent',
          'x-github-api-version': '2026-03-10',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal,
      })
      if (response.status === 401 && path.startsWith('/user/'))
        throw new ConflictException({
          code: 'CONFLICT',
          reason: 'GITHUB_AUTH_REQUIRED',
          message: 'GitHub 授权已失效，请重新授权后再选择仓库。',
        })
      if (response.status === 404) throw notAuthorized()
      if (!response.ok) throw unavailable()
      return schema.parse(await response.json())
    } catch (error) {
      if (error instanceof HttpException) throw error
      throw unavailable()
    }
  }
}
