import { createHash } from 'node:crypto'
import { z } from 'zod'
import { createGitHubEvidenceRequest, GitHubEvidenceError } from './github-evidence-http.js'

export const gitShaSchema = z
  .string()
  .regex(/^[a-fA-F0-9]{40}$/)
  .transform((value) => value.toLowerCase())

const contentSchema = z.object({
  type: z.string(),
  path: z.string(),
  sha: gitShaSchema,
  size: z.number().int().nonnegative().safe(),
  encoding: z.string().optional(),
  content: z.string().optional(),
})

// 两条比较路径共用同一份文件校验；只读取固定 SHA，不把 404 当成空文件。
export async function readCommitFile(
  request: ReturnType<typeof createGitHubEvidenceRequest>,
  input: {
    root: string
    commitSha: string
    path: string
    expectedBlobSha: string
    maxBytes: number
  },
) {
  const encodedPath = input.path.split('/').map(encodeURIComponent).join('/')
  const file = await request(
    `${input.root}/contents/${encodedPath}?ref=${input.commitSha}`,
    contentSchema,
  )
  if (file.type !== 'file') throw new GitHubEvidenceError('UNSUPPORTED_FILE')
  if (file.size > input.maxBytes) throw new GitHubEvidenceError('LIMIT_EXCEEDED')
  if (file.encoding !== 'base64' || file.content === undefined || file.path !== input.path) {
    throw new GitHubEvidenceError('INVALID_GITHUB_RESPONSE')
  }
  const encoded = file.content.replace(/\r?\n/g, '')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
    throw new GitHubEvidenceError('INVALID_GITHUB_RESPONSE')
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length > input.maxBytes) throw new GitHubEvidenceError('LIMIT_EXCEEDED')
  const blobSha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
  if (
    bytes.length !== file.size ||
    bytes.toString('base64') !== encoded ||
    blobSha !== file.sha ||
    blobSha !== input.expectedBlobSha
  )
    throw new GitHubEvidenceError('INVALID_GITHUB_RESPONSE')
  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new GitHubEvidenceError('UNSUPPORTED_FILE')
  }
  if (content.includes('\0')) throw new GitHubEvidenceError('UNSUPPORTED_FILE')
  return {
    content,
    contentHash: createHash('sha256').update(bytes).digest('hex'),
    lineCount:
      content === '' ? 0 : content.replace(/(?:\r\n|\n|\r)$/, '').split(/\r\n|\n|\r/).length,
  }
}
