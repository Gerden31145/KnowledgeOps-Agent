import { githubIdSchema, markdownTargetPathSchema } from '@knowledgeops/contracts'
import { z } from 'zod'
import { createGitHubEvidenceRequest, GitHubEvidenceError } from './github-evidence-http.js'
import { gitShaSchema, readCommitFile } from './read-commit-file.js'
import { readCommitSnapshots, readTargetFileSnapshot } from './read-commit-snapshots.js'

export const readCommitEvidenceInputSchema = z.object({
  githubRepositoryId: githubIdSchema,
  beforeCommitSha: gitShaSchema,
  afterCommitSha: gitShaSchema,
  targetPath: markdownTargetPathSchema.refine((path) =>
    path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
  ),
})
const limitsSchema = z.object({
  // Compare 最多给出 300 个文件；本模块的上限必须更小，不能信任被截断的列表。
  maxChangedFiles: z.number().int().min(1).max(299).default(100),
  maxMarkdownFiles: z.number().int().min(1).max(299).default(20),
  maxFileBytes: z
    .number()
    .int()
    .min(1)
    .max(1_000_000)
    .default(64 * 1024),
  maxDiffCharacters: z.number().int().min(1).max(1_000_000).default(128_000),
})
const repositorySchema = z.object({
  id: z.number().int().positive().safe(),
  full_name: z
    .string()
    .max(220)
    .regex(/^[\w.-]+\/[\w.-]+$/)
    .refine((name) => name.split('/').every((segment) => segment !== '.' && segment !== '..')),
})
const changeSchema = z.object({
  filename: z.string().min(1).max(1024),
  previous_filename: z.string().min(1).max(1024).optional(),
  sha: gitShaSchema,
  status: z.string(),
  additions: z.number().int().nonnegative().safe(),
  deletions: z.number().int().nonnegative().safe(),
  patch: z.string().optional(),
})
const comparisonSchema = z.object({
  base_commit: z.object({ sha: gitShaSchema }),
  merge_base_commit: z.object({ sha: gitShaSchema }),
  files: z.array(changeSchema),
})

export type ReadCommitEvidenceInput = z.input<typeof readCommitEvidenceInputSchema>
export type CommitEvidenceLimits = z.input<typeof limitsSchema>
export type ResolvedCommitEvidenceLimits = z.output<typeof limitsSchema>
export interface ReadCommitEvidenceOptions {
  // 调用方须先复核绑定，并按需取得仅覆盖所选仓库的安装 Token；不接受浏览器调用。
  installationToken: string
  fetchGitHub?: typeof fetch
  limits?: CommitEvidenceLimits
  // 只能由持久化的显式恢复请求选择，普通 Push 不自动降级为快照。
  evidenceMode?: 'DIFF' | 'SNAPSHOT'
}
export interface CommitFileEvidence {
  mode?: 'DIFF'
  githubRepositoryId: string
  beforeCommitSha: string
  afterCommitSha: string
  targetPath: string
  previousPath: string | null
  change: 'added' | 'modified' | 'removed' | 'renamed'
  sourceCommitSha: string
  content: string
  contentHash: string
  lineCount: number
  diff: string
}
export type CommitSnapshotEvidence = Omit<
  CommitFileEvidence,
  'mode' | 'change' | 'diff' | 'previousPath'
> & {
  mode: 'SNAPSHOT'
  change: null
  diff: null
  previousPath: null
}
export type ReadCommitEvidenceResult =
  | { status: 'COLLECTED'; evidence: CommitFileEvidence | CommitSnapshotEvidence }
  | { status: 'IGNORED'; reason: 'NO_MARKDOWN_CHANGE' | 'TARGET_NOT_CHANGED' | 'TARGET_RENAMED' }

// R06 首轮核心入口：只读证据，不负责创建 Run、写库、改变 Task 或判断笔记是否通过。
export async function readCommitEvidence(
  input: ReadCommitEvidenceInput,
  options: ReadCommitEvidenceOptions,
): Promise<ReadCommitEvidenceResult> {
  const parsed = readCommitEvidenceInputSchema.safeParse(input)
  const configured = limitsSchema.safeParse(options.limits ?? {})
  if (!parsed.success || !configured.success) throw new GitHubEvidenceError('INVALID_INPUT')
  const { githubRepositoryId, beforeCommitSha, afterCommitSha, targetPath } = parsed.data
  const limits = configured.data
  if (
    (options.evidenceMode !== 'SNAPSHOT' && /^0+$/.test(beforeCommitSha)) ||
    /^0+$/.test(afterCommitSha)
  ) {
    throw new GitHubEvidenceError('RESYNC_REQUIRED')
  }
  const request = createGitHubEvidenceRequest(options.installationToken, options.fetchGitHub)

  // 1. 使用本地绑定的 GitHub 仓库 ID 确认上游仓库，不相信 Webhook 中可变化的全名。
  const repository = await request(`/repositories/${githubRepositoryId}`, repositorySchema)
  if (String(repository.id) !== githubRepositoryId) {
    throw new GitHubEvidenceError('INVALID_GITHUB_RESPONSE')
  }
  const root = `/repos/${repository.full_name}`

  if (options.evidenceMode === 'SNAPSHOT') {
    return readTargetFileSnapshot(parsed.data, { root, request, limits })
  }

  // 2. 固定两个提交做比较；第一页包含文件列表，不必下载所有提交的作者/消息信息。
  let comparison: z.output<typeof comparisonSchema>
  try {
    comparison = await request(
      `${root}/compare/${beforeCommitSha}...${afterCommitSha}?per_page=1&page=1`,
      comparisonSchema,
    )
  } catch (error) {
    // 无共同祖先的 Compare 也可能 404；先核实两端快照，不能把它当成空 Diff。
    if (error instanceof GitHubEvidenceError && error.code === 'SOURCE_UNAVAILABLE')
      return readCommitSnapshots(parsed.data, { root, request, limits })
    throw error
  }
  if (comparison.base_commit.sha !== beforeCommitSha) {
    throw new GitHubEvidenceError('INVALID_GITHUB_RESPONSE')
  }
  // 只有共同祖先就是 before，Compare 的 Diff 才能直接作为本次 Push 的证据。
  if (comparison.merge_base_commit.sha !== beforeCommitSha) {
    return readCommitSnapshots(parsed.data, { root, request, limits })
  }
  const files = comparison.files
  const markdownFiles = files.filter(
    (file) => /\.md$/i.test(file.filename) || /\.md$/i.test(file.previous_filename ?? ''),
  )
  if (
    files.length > limits.maxChangedFiles ||
    markdownFiles.length > limits.maxMarkdownFiles ||
    files.reduce((count, file) => count + (file.patch?.length ?? 0), 0) > limits.maxDiffCharacters
  )
    throw new GitHubEvidenceError('LIMIT_EXCEEDED')
  if (!markdownFiles.length) return { status: 'IGNORED', reason: 'NO_MARKDOWN_CHANGE' }

  const matches = files.filter((file) => file.filename === targetPath)
  if (matches.length > 1) throw new GitHubEvidenceError('INVALID_GITHUB_RESPONSE')
  const changed = matches[0]
  if (!changed) {
    const renamed = files.some(
      (file) => file.status === 'renamed' && file.previous_filename === targetPath,
    )
    return { status: 'IGNORED', reason: renamed ? 'TARGET_RENAMED' : 'TARGET_NOT_CHANGED' }
  }
  const change = z.enum(['added', 'modified', 'removed', 'renamed']).safeParse(changed.status)
  if (!change.success) throw new GitHubEvidenceError('UNSUPPORTED_FILE')
  if (change.data === 'renamed' && !changed.previous_filename) {
    throw new GitHubEvidenceError('INVALID_GITHUB_RESPONSE')
  }
  const diff = changed.patch ?? ''
  const diffLines = diff.split('\n')
  if (
    diffLines.filter((line) => line.startsWith('+')).length !== changed.additions ||
    diffLines.filter((line) => line.startsWith('-')).length !== changed.deletions ||
    ((changed.additions > 0 || changed.deletions > 0) && !diff.startsWith('@@ '))
  )
    throw new GitHubEvidenceError('INCOMPLETE_DIFF')

  // 3. 正常文件读取 after；删除文件读取 before，并明确标记 removed，绝不当成当前正文。
  const sourceCommitSha = change.data === 'removed' ? beforeCommitSha : afterCommitSha
  const file = await readCommitFile(request, {
    root,
    commitSha: sourceCommitSha,
    path: targetPath,
    expectedBlobSha: changed.sha,
    maxBytes: limits.maxFileBytes,
  })

  // 4. 返回完整正文及来源，保留原始字节的哈希；后续由事务层保存，当前不产生验收结论。
  return {
    status: 'COLLECTED',
    evidence: {
      githubRepositoryId,
      beforeCommitSha,
      afterCommitSha,
      targetPath,
      previousPath: changed.previous_filename ?? null,
      change: change.data,
      sourceCommitSha,
      ...file,
      diff,
    },
  }
}
