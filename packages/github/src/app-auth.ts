import { createPrivateKey, sign } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { githubIdSchema } from '@knowledgeops/contracts'
import { z } from 'zod'

const id = z.number().int().positive().safe()
export const githubInstallationSchema = z.object({
  id,
  account: z.object({ id, login: z.string().min(1).max(100) }),
  permissions: z.object({ contents: z.string().optional() }),
  repository_selection: z.enum(['all', 'selected']),
  suspended_at: z.string().nullable(),
})

export interface GitHubAppSettings {
  GITHUB_APP_CLIENT_ID?: string | undefined
  GITHUB_APP_PRIVATE_KEY_PATH?: string | undefined
}

// 只暴露固定原因；私钥加载错误、上游原文和 Token 不进入错误信息。
export class GitHubAppAuthError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'NOT_AUTHORIZED' | 'APP_UNAVAILABLE') {
    super(code)
    this.name = 'GitHubAppAuthError'
  }
}

export function isUsableGitHubInstallation(item: z.infer<typeof githubInstallationSchema>) {
  return (
    item.suspended_at === null &&
    item.permissions.contents === 'read' &&
    item.repository_selection === 'selected'
  )
}

// 沿用 R04 的短期 RS256 App 身份凭据；不是浏览器登录会话。
export async function createGitHubAppJwt(
  settings: GitHubAppSettings,
  loadKey: (path: string) => Promise<string> = (path) => readFile(path, 'utf8'),
): Promise<string> {
  try {
    const path = settings.GITHUB_APP_PRIVATE_KEY_PATH
    const issuer = settings.GITHUB_APP_CLIENT_ID
    if (!path || !issuer) throw new GitHubAppAuthError('APP_UNAVAILABLE')
    const key = createPrivateKey(await loadKey(path))
    if (key.asymmetricKeyType !== 'rsa') throw new GitHubAppAuthError('APP_UNAVAILABLE')
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const now = Math.floor(Date.now() / 1000)
    const input = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: issuer, iat: now - 60, exp: now + 300 })}`
    return `${input}.${sign('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`
  } catch {
    throw new GitHubAppAuthError('APP_UNAVAILABLE')
  }
}

// request 由调用方绑定 App JWT 和限时 HTTP 传输；这里不接收用户 OAuth Token。
export async function createGitHubRepositoryAccess(
  installationId: string,
  githubRepositoryId: string,
  request: <T>(path: string, schema: z.ZodType<T>, body?: unknown) => Promise<T>,
) {
  if (
    !githubIdSchema.safeParse(installationId).success ||
    !githubIdSchema.safeParse(githubRepositoryId).success
  )
    throw new GitHubAppAuthError('INVALID_INPUT')

  const installation = await request(
    `/app/installations/${installationId}`,
    githubInstallationSchema,
  )
  if (String(installation.id) !== installationId || !isUsableGitHubInstallation(installation))
    throw new GitHubAppAuthError('NOT_AUTHORIZED')

  // 必须显式限制为这一个仓库及只读权限，不能省略后得到整个安装的权限。
  const access = await request(
    `/app/installations/${installationId}/access_tokens`,
    z.object({ token: z.string().min(1).regex(/^\S+$/), expires_at: z.iso.datetime() }),
    {
      repository_ids: [Number(githubRepositoryId)],
      permissions: { contents: 'read', metadata: 'read' },
    },
  )
  if (new Date(access.expires_at).getTime() <= Date.now() + 30_000)
    throw new GitHubAppAuthError('APP_UNAVAILABLE')
  // 只在本次服务端调用内使用，不写数据库、日志或返回浏览器。
  return { token: access.token, installation }
}
