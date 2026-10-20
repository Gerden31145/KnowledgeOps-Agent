import { createTwoFilesPatch, OMIT_HEADERS } from 'diff'
import { z } from 'zod'
import { createGitHubEvidenceRequest, GitHubEvidenceError } from './github-evidence-http.js'
import { gitShaSchema, readCommitFile } from './read-commit-file.js'
import type {
  ResolvedCommitEvidenceLimits,
  ReadCommitEvidenceInput,
  ReadCommitEvidenceResult,
} from './read-commit-evidence.js'

const commitSchema = z.object({ sha: gitShaSchema, tree: z.object({ sha: gitShaSchema }) })
const entrySchema = z.object({
  path: z
    .string()
    .min(1)
    .max(1024)
    .refine(
      (path) =>
        !/[\0\r\n]/.test(path) &&
        path.split('/').every((part) => part && part !== '.' && part !== '..'),
    ),
  sha: gitShaSchema,
  type: z.enum(['blob', 'tree', 'commit']),
  mode: z.enum(['100644', '100755', '120000', '040000', '160000']),
})
const treeSchema = z.object({
  sha: gitShaSchema,
  truncated: z.boolean(),
  tree: z.array(entrySchema),
})
type Entry = z.output<typeof entrySchema>
type Request = ReturnType<typeof createGitHubEvidenceRequest>

// 分叉/无共同祖先时，只比较两个固定快照，不下载或重建仓库历史。
export async function readCommitSnapshots(
  input: ReadCommitEvidenceInput,
  options: { root: string; request: Request; limits: ResolvedCommitEvidenceLimits },
): Promise<ReadCommitEvidenceResult> {
  const { root, request, limits } = options
  const { beforeCommitSha, afterCommitSha, targetPath } = input
  const before = await readTree(request, root, beforeCommitSha)
  const after = await readTree(request, root, afterCommitSha)

  // 完整树证明路径存在/不存在；不能根据 Contents 的 404 推断文件被添加或删除。
  const changedPaths = [...new Set([...before.keys(), ...after.keys()])].filter((path) => {
    const old = before.get(path)
    const next = after.get(path)
    if ((!old || old.type === 'tree') && (!next || next.type === 'tree')) return false
    return old?.sha !== next?.sha || old?.mode !== next?.mode
  })
  const markdownPaths = changedPaths.filter((path) => /\.md$/i.test(path))
  if (
    changedPaths.length > limits.maxChangedFiles ||
    markdownPaths.length > limits.maxMarkdownFiles
  )
    throw new GitHubEvidenceError('LIMIT_EXCEEDED')
  if (!markdownPaths.length) return { status: 'IGNORED', reason: 'NO_MARKDOWN_CHANGE' }
  if (!changedPaths.includes(targetPath)) return { status: 'IGNORED', reason: 'TARGET_NOT_CHANGED' }

  const old = before.get(targetPath)
  const next = after.get(targetPath)
  for (const entry of [old, next]) {
    if (entry && !isRegularFile(entry)) throw new GitHubEvidenceError('UNSUPPORTED_FILE')
  }

  // 只识别内容不变且唯一对应的改名；其他情况严格按固定路径的增删处理，不猜新目标。
  const removed = changedPaths.filter((path) => before.has(path) && !after.has(path))
  const added = changedPaths.filter((path) => !before.has(path) && after.has(path))
  const renameFrom = (path: string, entry: Entry) => {
    const sources = removed.filter((candidate) => sameFile(before.get(candidate), entry))
    const destinations = added.filter((candidate) => sameFile(after.get(candidate), entry))
    return sources.length === 1 && destinations.length === 1 && destinations[0] === path
      ? sources[0]!
      : null
  }
  if (old && !next && added.some((path) => renameFrom(path, old) === targetPath))
    return { status: 'IGNORED', reason: 'TARGET_RENAMED' }
  const previousPath = !old && next ? renameFrom(targetPath, next) : null
  const change = !next ? 'removed' : previousPath ? 'renamed' : old ? 'modified' : 'added'

  const read = (commitSha: string, path: string, entry: Entry) =>
    readCommitFile(request, {
      root,
      commitSha,
      path,
      expectedBlobSha: entry.sha,
      maxBytes: limits.maxFileBytes,
    }).catch(requireResyncIfMissing)
  const oldPath = previousPath ?? targetPath
  const oldEntry = before.get(oldPath)
  const oldFile = oldEntry ? await read(beforeCommitSha, oldPath, oldEntry) : undefined
  const newFile = next ? await read(afterCommitSha, targetPath, next) : undefined
  const source = newFile ?? oldFile
  if (!source) throw new GitHubEvidenceError('INVALID_GITHUB_RESPONSE')

  const oldContent = oldFile?.content ?? ''
  const newContent = newFile?.content ?? ''
  const diff =
    oldContent === newContent
      ? ''
      : createTwoFilesPatch('', '', oldContent, newContent, undefined, undefined, {
          context: 3,
          headerOptions: OMIT_HEADERS,
          maxEditLength: 10_000,
          timeout: 200,
        })
  if (diff === undefined || diff.length > limits.maxDiffCharacters)
    throw new GitHubEvidenceError('LIMIT_EXCEEDED')
  return {
    status: 'COLLECTED',
    evidence: {
      ...input,
      previousPath,
      change,
      sourceCommitSha: next ? afterCommitSha : beforeCommitSha,
      ...source,
      diff,
    },
  }
}

// 显式重新同步：只读取原 after 的目标文件，不访问 before、Compare 或当前分支。
// null 表示“不具备变化证据”，与真正比较得到的空 Diff 是不同事实。
export async function readTargetFileSnapshot(
  input: ReadCommitEvidenceInput,
  options: { root: string; request: Request; limits: ResolvedCommitEvidenceLimits },
): Promise<ReadCommitEvidenceResult> {
  const { root, request, limits } = options
  const tree = await readTree(request, root, input.afterCommitSha)
  const target = tree.get(input.targetPath)
  if (!target) throw new GitHubEvidenceError('SOURCE_UNAVAILABLE')
  if (!isRegularFile(target)) throw new GitHubEvidenceError('UNSUPPORTED_FILE')
  const file = await readCommitFile(request, {
    root,
    commitSha: input.afterCommitSha,
    path: input.targetPath,
    expectedBlobSha: target.sha,
    maxBytes: limits.maxFileBytes,
  })
  return {
    status: 'COLLECTED',
    evidence: {
      ...input,
      mode: 'SNAPSHOT',
      change: null,
      previousPath: null,
      sourceCommitSha: input.afterCommitSha,
      ...file,
      diff: null,
    },
  }
}

async function readTree(request: Request, root: string, commitSha: string) {
  const commit = await request(`${root}/git/commits/${commitSha}`, commitSchema).catch(
    requireResyncIfMissing,
  )
  if (commit.sha !== commitSha) throw new GitHubEvidenceError('INVALID_GITHUB_RESPONSE')
  const result = await request(
    `${root}/git/trees/${commit.tree.sha}?recursive=1`,
    treeSchema,
  ).catch(requireResyncIfMissing)
  if (result.sha !== commit.tree.sha) throw new GitHubEvidenceError('INVALID_GITHUB_RESPONSE')
  if (result.truncated) throw new GitHubEvidenceError('LIMIT_EXCEEDED')
  const entries = new Map<string, Entry>()
  for (const entry of result.tree) {
    const expectedType =
      entry.mode === '040000' ? 'tree' : entry.mode === '160000' ? 'commit' : 'blob'
    if (entry.type !== expectedType || entries.has(entry.path))
      throw new GitHubEvidenceError('INVALID_GITHUB_RESPONSE')
    entries.set(entry.path, entry)
  }
  return entries
}

function isRegularFile(entry: Entry) {
  return entry.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755')
}

function sameFile(candidate: Entry | undefined, entry: Entry) {
  return (
    candidate &&
    isRegularFile(candidate) &&
    candidate.sha === entry.sha &&
    candidate.mode === entry.mode
  )
}

function requireResyncIfMissing(error: unknown): never {
  if (error instanceof GitHubEvidenceError && error.code === 'SOURCE_UNAVAILABLE')
    throw new GitHubEvidenceError('RESYNC_REQUIRED')
  throw error
}
