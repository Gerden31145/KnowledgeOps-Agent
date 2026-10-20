import type { z } from 'zod'

export type GitHubEvidenceErrorCode =
  | 'INVALID_INPUT'
  | 'GITHUB_UNAVAILABLE'
  | 'GITHUB_AUTH_REQUIRED'
  | 'SOURCE_UNAVAILABLE'
  | 'LIMIT_EXCEEDED'
  | 'INVALID_GITHUB_RESPONSE'
  | 'INCOMPLETE_DIFF'
  | 'UNSUPPORTED_FILE'
  | 'UNSUPPORTED_COMPARISON'
  | 'RESYNC_REQUIRED'

// 错误只携带固定代码，不携带 Token、私有正文、上游原文或 fetch 的 cause。
export class GitHubEvidenceError extends Error {
  constructor(readonly code: GitHubEvidenceErrorCode) {
    super(code)
    this.name = 'GitHubEvidenceError'
  }
}

export const MAX_GITHUB_EVIDENCE_RESPONSE_BYTES = 2 * 1024 * 1024

export function createGitHubEvidenceRequest(credential: string, fetchGitHub: typeof fetch = fetch) {
  if (!credential.trim() || /\s/.test(credential)) {
    throw new GitHubEvidenceError('INVALID_INPUT')
  }
  // 一次取证共用总超时，不让每个请求分别消耗完整 20 秒。
  const signal = AbortSignal.timeout(20_000)

  return async <T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> => {
    try {
      const response = await fetchGitHub(`https://api.github.com${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${credential}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          'user-agent': 'KnowledgeOps-Agent',
          'x-github-api-version': '2026-03-10',
        },
        redirect: 'error',
        signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      if (!response.ok) {
        await response.body?.cancel()
        if (response.status === 401) throw new GitHubEvidenceError('GITHUB_AUTH_REQUIRED')
        if (response.status === 404) throw new GitHubEvidenceError('SOURCE_UNAVAILABLE')
        throw new GitHubEvidenceError('GITHUB_UNAVAILABLE')
      }
      if (Number(response.headers.get('content-length')) > MAX_GITHUB_EVIDENCE_RESPONSE_BYTES) {
        await response.body?.cancel()
        throw new GitHubEvidenceError('LIMIT_EXCEEDED')
      }
      if (!response.body) throw new GitHubEvidenceError('INVALID_GITHUB_RESPONSE')

      // Content-Length 可能缺失或不准确，仍逐块计算实际字节数并在超限时停止读取。
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > MAX_GITHUB_EVIDENCE_RESPONSE_BYTES) {
            await reader.cancel()
            throw new GitHubEvidenceError('LIMIT_EXCEEDED')
          }
          chunks.push(value)
        }
      } finally {
        reader.releaseLock()
      }
      let json: unknown
      try {
        json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
      } catch {
        throw new GitHubEvidenceError('INVALID_GITHUB_RESPONSE')
      }
      const parsed = schema.safeParse(json)
      if (!parsed.success) throw new GitHubEvidenceError('INVALID_GITHUB_RESPONSE')
      return parsed.data
    } catch (error) {
      if (error instanceof GitHubEvidenceError) throw error
      throw new GitHubEvidenceError('GITHUB_UNAVAILABLE')
    }
  }
}
