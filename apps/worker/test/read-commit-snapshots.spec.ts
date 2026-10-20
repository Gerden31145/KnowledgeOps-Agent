import { createHash } from 'node:crypto'
import { applyPatch } from 'diff'
import { describe, expect, it, vi } from 'vitest'
import {
  readCommitEvidence,
  type CommitEvidenceLimits,
} from '../src/github/read-commit-evidence.js'

// 合成 GitHub 响应；执行真实读取/校验/Diff，不访问凭据、数据库、Redis 或真实仓库。
const BEFORE = 'a'.repeat(40)
const AFTER = 'b'.repeat(40)
const BEFORE_TREE = 'c'.repeat(40)
const AFTER_TREE = 'd'.repeat(40)
const ROOT = '/repos/student/notes'
const PATH = 'notes/vue.md'
const INPUT = {
  githubRepositoryId: '123',
  beforeCommitSha: BEFORE,
  afterCommitSha: AFTER,
  targetPath: PATH,
}
const OLD = '# Vue\nbefore 的正文\n'
const NEXT = '# Vue\nafter 的正文\n'

function file(content: string) {
  const bytes = Buffer.from(content)
  return {
    type: 'file',
    path: PATH,
    size: bytes.length,
    encoding: 'base64',
    content: bytes.toString('base64'),
    sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
  }
}

function fixture(oldContent = OLD, newContent = NEXT) {
  const oldFile = file(oldContent)
  const newFile = file(newContent)
  const entry = (value: ReturnType<typeof file>) => ({
    path: value.path,
    sha: value.sha,
    mode: '100644',
    type: 'blob',
  })
  const before = { sha: BEFORE_TREE, truncated: false, tree: [entry(oldFile)] }
  const after = { sha: AFTER_TREE, truncated: false, tree: [entry(newFile)] }
  const oldCommit = { sha: BEFORE, tree: { sha: BEFORE_TREE } }
  const newCommit = { sha: AFTER, tree: { sha: AFTER_TREE } }
  const comparison = {
    base_commit: { sha: BEFORE },
    merge_base_commit: { sha: 'e'.repeat(40) },
    // 故意不列出目标文件：merge-base→after 的列表不能决定 before→after 是否变化。
    files: [] as {
      filename: string
      sha: string
      status: string
      additions: number
      deletions: number
      patch: string
    }[],
  }
  const errors = new Map<string, number>()
  const upstream = vi.fn<typeof fetch>(async (url) => {
    const parsed = new URL(String(url))
    const path = parsed.pathname
    const status = errors.get(path + parsed.search) ?? errors.get(path)
    if (status) return new Response('FIXTURE_PRIVATE_UPSTREAM_ERROR', { status })
    if (path === '/repositories/123') return Response.json({ id: 123, full_name: 'student/notes' })
    if (path === `${ROOT}/compare/${BEFORE}...${AFTER}`) return Response.json(comparison)
    if (path === `${ROOT}/git/commits/${BEFORE}`) return Response.json(oldCommit)
    if (path === `${ROOT}/git/commits/${AFTER}`) return Response.json(newCommit)
    if (path === `${ROOT}/git/trees/${BEFORE_TREE}`) return Response.json(before)
    if (path === `${ROOT}/git/trees/${AFTER_TREE}`) return Response.json(after)
    if (path.startsWith(`${ROOT}/contents/`)) {
      const ref = parsed.searchParams.get('ref')
      if (ref === BEFORE) return Response.json(oldFile)
      if (ref === AFTER) return Response.json(newFile)
    }
    throw new Error('FIXTURE_UNEXPECTED_OR_UNPINNED_REQUEST')
  })
  const read = (limits: CommitEvidenceLimits = {}) =>
    readCommitEvidence(INPUT, {
      installationToken: 'fixture-installation-token',
      fetchGitHub: upstream,
      limits,
    })
  return {
    oldFile,
    newFile,
    before,
    after,
    oldCommit,
    newCommit,
    comparison,
    errors,
    upstream,
    read,
    snapshot: (limits: CommitEvidenceLimits = {}) =>
      readCommitEvidence(INPUT, {
        installationToken: 'fixture-installation-token',
        fetchGitHub: upstream,
        limits,
        evidenceMode: 'SNAPSHOT',
      }),
  }
}

describe('R06 explicit single snapshot resync (synthetic GitHub responses)', () => {
  it('keeps ordinary intake in RESYNC_REQUIRED, then reads only the original after SHA when explicitly requested', async () => {
    const f = fixture()
    f.errors.set(`${ROOT}/git/commits/${BEFORE}`, 404)
    await expect(f.read()).rejects.toMatchObject({ code: 'RESYNC_REQUIRED' })
    f.upstream.mockClear()
    await expect(f.snapshot()).resolves.toEqual({
      status: 'COLLECTED',
      evidence: {
        ...INPUT,
        mode: 'SNAPSHOT',
        change: null,
        diff: null,
        previousPath: null,
        sourceCommitSha: AFTER,
        content: NEXT,
        lineCount: 2,
        contentHash: createHash('sha256').update(NEXT).digest('hex'),
      },
    })
    expect(f.upstream.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/repositories/123',
      `${ROOT}/git/commits/${AFTER}`,
      `${ROOT}/git/trees/${AFTER_TREE}`,
      `${ROOT}/contents/${PATH}`,
    ])
    expect(f.upstream.mock.lastCall?.[0]).toContain(`?ref=${AFTER}`)
  })

  it('accepts unchanged or empty current content as a snapshot, not proof of change or a passing note', async () => {
    const f = fixture('', '')
    await expect(f.snapshot()).resolves.toMatchObject({
      status: 'COLLECTED',
      evidence: { mode: 'SNAPSHOT', change: null, diff: null, content: '', lineCount: 0 },
    })
  })

  it.each([
    [`${ROOT}/git/commits/${AFTER}`, 'RESYNC_REQUIRED'],
    [`${ROOT}/git/trees/${AFTER_TREE}`, 'RESYNC_REQUIRED'],
    [`${ROOT}/contents/${PATH}?ref=${AFTER}`, 'SOURCE_UNAVAILABLE'],
  ])(
    'does not fabricate empty content or a deletion when %s is unavailable',
    async (path, code) => {
      const f = fixture()
      f.errors.set(path, 404)
      await expect(f.snapshot()).rejects.toMatchObject({ code })
    },
  )

  it('does not reinterpret an absent target as removed or pick another Markdown file', async () => {
    const f = fixture()
    f.after.tree[0]!.path = 'other.md'
    await expect(f.snapshot()).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' })
    expect(f.upstream.mock.calls.some(([url]) => String(url).includes('/contents/'))).toBe(false)
  })

  it.each(['commit', 'tree', 'blob', 'path'] as const)(
    'checks the fixed %s identity',
    async (kind) => {
      const f = fixture()
      if (kind === 'commit') f.newCommit.sha = 'e'.repeat(40)
      if (kind === 'tree') f.after.sha = 'e'.repeat(40)
      if (kind === 'blob') f.after.tree[0]!.sha = 'e'.repeat(40)
      if (kind === 'path') f.newFile.path = 'other.md'
      await expect(f.snapshot()).rejects.toMatchObject({ code: 'INVALID_GITHUB_RESPONSE' })
    },
  )

  it.each(['120000', '160000', '040000'])('rejects a non-file mode %s', async (mode) => {
    const f = fixture()
    f.after.tree[0]!.mode = mode
    f.after.tree[0]!.type = mode === '160000' ? 'commit' : mode === '040000' ? 'tree' : 'blob'
    await expect(f.snapshot()).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE' })
  })

  it('still rejects truncated trees and oversized content', async () => {
    const f = fixture()
    f.after.truncated = true
    await expect(f.snapshot()).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    f.after.truncated = false
    await expect(f.snapshot({ maxFileBytes: 1 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
  })
})

describe('R06 direct before→after snapshots (synthetic GitHub responses)', () => {
  it('compares actual before→after even when the merge-base file list omits the target', async () => {
    const f = fixture()
    const result = await f.read()
    expect(result).toMatchObject({
      status: 'COLLECTED',
      evidence: {
        ...INPUT,
        change: 'modified',
        previousPath: null,
        sourceCommitSha: AFTER,
        content: NEXT,
        lineCount: 2,
        contentHash: createHash('sha256').update(NEXT).digest('hex'),
      },
    })
    if (result.status !== 'COLLECTED' || result.evidence.diff === null)
      throw new Error('Expected Diff evidence')
    expect(result.evidence.diff).toContain('-before 的正文')
    expect(result.evidence.diff).toContain('+after 的正文')
    expect(applyPatch(OLD, result.evidence.diff)).toBe(NEXT)
    expect(f.upstream.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/repositories/123',
      `${ROOT}/compare/${BEFORE}...${AFTER}`,
      `${ROOT}/git/commits/${BEFORE}`,
      `${ROOT}/git/trees/${BEFORE_TREE}`,
      `${ROOT}/git/commits/${AFTER}`,
      `${ROOT}/git/trees/${AFTER_TREE}`,
      `${ROOT}/contents/${PATH}`,
      `${ROOT}/contents/${PATH}`,
    ])
    const signal = f.upstream.mock.calls[0]![1]!.signal
    for (const [url, init] of f.upstream.mock.calls) {
      expect(new URL(String(url)).origin).toBe('https://api.github.com')
      expect(init).toMatchObject({
        redirect: 'error',
        signal,
        headers: { authorization: 'Bearer fixture-installation-token' },
      })
    }
    expect(
      f.upstream.mock.calls.slice(-2).map(([url]) => new URL(String(url)).searchParams.get('ref')),
    ).toEqual([BEFORE, AFTER])
  })

  it('can compare readable snapshots even when Compare cannot find a common ancestor', async () => {
    const f = fixture()
    f.errors.set(`${ROOT}/compare/${BEFORE}...${AFTER}`, 404)
    await expect(f.read()).resolves.toMatchObject({
      status: 'COLLECTED',
      evidence: { content: NEXT },
    })
  })

  it('requires resynchronization when Compare and the original commit are both unavailable', async () => {
    const f = fixture()
    f.errors.set(`${ROOT}/compare/${BEFORE}...${AFTER}`, 404)
    f.errors.set(`${ROOT}/git/commits/${BEFORE}`, 404)
    await expect(f.read()).rejects.toMatchObject({ code: 'RESYNC_REQUIRED' })
    expect(f.upstream).toHaveBeenCalledTimes(3)
  })

  it.each([401, 429, 503])('does not bypass Compare HTTP %i via another API', async (status) => {
    const f = fixture()
    f.errors.set(`${ROOT}/compare/${BEFORE}...${AFTER}`, status)
    await expect(f.read()).rejects.toMatchObject({
      code: status === 401 ? 'GITHUB_AUTH_REQUIRED' : 'GITHUB_UNAVAILABLE',
    })
    expect(f.upstream).toHaveBeenCalledTimes(2)
  })

  it('does not accept a merge-base change when the two target snapshots are identical', async () => {
    const f = fixture(OLD, OLD)
    f.comparison.files = [
      {
        filename: PATH,
        sha: f.newFile.sha,
        status: 'modified',
        additions: 1,
        deletions: 1,
        patch: '@@ -1 +1 @@\n-ancestor\n+unchanged target',
      },
    ]
    await expect(f.read()).resolves.toEqual({ status: 'IGNORED', reason: 'NO_MARKDOWN_CHANGE' })
    expect(f.upstream.mock.calls.some(([url]) => String(url).includes('/contents/'))).toBe(false)
  })

  it('ignores an unchanged target when another Markdown path changed', async () => {
    const f = fixture(OLD, OLD)
    f.after.tree.push({ ...f.after.tree[0]!, path: 'other.md' })
    await expect(f.read()).resolves.toEqual({ status: 'IGNORED', reason: 'TARGET_NOT_CHANGED' })
  })

  it('recognizes an addition only after a complete before tree proves the path absent', async () => {
    const f = fixture()
    f.before.tree = []
    const result = await f.read()
    expect(result).toMatchObject({
      status: 'COLLECTED',
      evidence: { change: 'added', content: NEXT, sourceCommitSha: AFTER },
    })
    if (result.status !== 'COLLECTED' || result.evidence.diff === null)
      throw new Error('Expected Diff evidence')
    expect(applyPatch('', result.evidence.diff)).toBe(NEXT)
    expect(
      f.upstream.mock.calls.filter(([url]) => String(url).includes('/contents/')),
    ).toHaveLength(1)
  })

  it('reads deleted content from before and labels it removed, never as the current note', async () => {
    const f = fixture()
    f.after.tree = []
    const result = await f.read()
    expect(result).toMatchObject({
      status: 'COLLECTED',
      evidence: { change: 'removed', content: OLD, sourceCommitSha: BEFORE },
    })
    if (result.status !== 'COLLECTED' || result.evidence.diff === null)
      throw new Error('Expected Diff evidence')
    expect(applyPatch(OLD, result.evidence.diff)).toBe('')
    expect(f.upstream.mock.lastCall?.[0]).toContain(`?ref=${BEFORE}`)
  })

  it.each(['added', 'removed'] as const)(
    'distinguishes an empty %s file from an unavailable source',
    async (change) => {
      const f = fixture('', '')
      if (change === 'added') f.before.tree = []
      else f.after.tree = []
      await expect(f.read()).resolves.toMatchObject({
        status: 'COLLECTED',
        evidence: {
          change,
          content: '',
          diff: '',
          lineCount: 0,
          sourceCommitSha: change === 'added' ? AFTER : BEFORE,
        },
      })
    },
  )

  it('does not follow an unchanged target renamed to a different path', async () => {
    const f = fixture(OLD, OLD)
    f.after.tree[0]!.path = 'notes/moved.md'
    await expect(f.read()).resolves.toEqual({ status: 'IGNORED', reason: 'TARGET_RENAMED' })
    expect(f.upstream).toHaveBeenCalledTimes(6)
  })

  it('records a unique identical-file rename into the configured target', async () => {
    const f = fixture(OLD, OLD)
    f.before.tree[0]!.path = 'notes/old.md'
    f.oldFile.path = 'notes/old.md'
    await expect(f.read()).resolves.toMatchObject({
      status: 'COLLECTED',
      evidence: {
        change: 'renamed',
        previousPath: 'notes/old.md',
        targetPath: PATH,
        content: OLD,
        diff: '',
      },
    })
  })

  it('does not guess rename identity when multiple old files have identical content', async () => {
    const f = fixture(OLD, OLD)
    f.before.tree[0]!.path = 'old-a.md'
    f.before.tree.push({ ...f.before.tree[0]!, path: 'old-b.md' })
    await expect(f.read()).resolves.toMatchObject({
      status: 'COLLECTED',
      evidence: {
        change: 'added',
        previousPath: null,
        content: OLD,
      },
    })
  })

  it.each([
    [`${ROOT}/git/commits/${BEFORE}`],
    [`${ROOT}/git/commits/${AFTER}`],
    [`${ROOT}/git/trees/${BEFORE_TREE}`],
    [`${ROOT}/git/trees/${AFTER_TREE}`],
    [`${ROOT}/contents/${PATH}?ref=${BEFORE}`],
  ])(
    'requires resynchronization when pinned source %s is unavailable; never reads main',
    async (path) => {
      const f = fixture()
      f.errors.set(path, 404)
      await expect(f.read()).rejects.toMatchObject({
        code: 'RESYNC_REQUIRED',
        message: 'RESYNC_REQUIRED',
      })
      expect(f.upstream.mock.calls.every(([url]) => !String(url).includes('main'))).toBe(true)
    },
  )

  it.each([
    [401, 'GITHUB_AUTH_REQUIRED'],
    [429, 'GITHUB_UNAVAILABLE'],
    [503, 'GITHUB_UNAVAILABLE'],
  ])(
    'preserves HTTP %i failure meaning instead of treating it as a missing file',
    async (status, code) => {
      const f = fixture()
      f.errors.set(`${ROOT}/git/commits/${BEFORE}`, Number(status))
      await expect(f.read()).rejects.toMatchObject({ code })
    },
  )

  it.each(['before', 'after'] as const)(
    'refuses a truncated %s tree, even when the target is present',
    async (side) => {
      const f = fixture()
      f[side].truncated = true
      await expect(f.read()).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
      expect(f.upstream.mock.calls.some(([url]) => String(url).includes('/contents/'))).toBe(false)
    },
  )

  it.each(['commit SHA', 'tree SHA', 'duplicate path', 'unsafe path', 'mode/type'])(
    'rejects inconsistent snapshot metadata: %s',
    async (kind) => {
      const f = fixture()
      if (kind === 'commit SHA') f.oldCommit.sha = AFTER
      if (kind === 'tree SHA') f.before.sha = AFTER_TREE
      if (kind === 'duplicate path') f.before.tree.push({ ...f.before.tree[0]! })
      if (kind === 'unsafe path') f.before.tree[0]!.path = '../private.md'
      if (kind === 'mode/type') f.before.tree[0]!.mode = '040000'
      await expect(f.read()).rejects.toMatchObject({ code: 'INVALID_GITHUB_RESPONSE' })
    },
  )

  it.each([
    { mode: '120000', type: 'blob' },
    { mode: '160000', type: 'commit' },
    { mode: '040000', type: 'tree' },
  ])('refuses target symlinks, submodules and directories: %j', async (entry) => {
    const f = fixture()
    Object.assign(f.after.tree[0]!, entry)
    await expect(f.read()).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE' })
  })

  it.each([
    { maxChangedFiles: 1 },
    { maxMarkdownFiles: 1 },
    { maxFileBytes: 1 },
    { maxDiffCharacters: 1 },
  ])('enforces direct-comparison limits instead of truncating evidence: %j', async (limits) => {
    const f = fixture()
    f.after.tree.push({ ...f.after.tree[0]!, path: 'other.md' })
    await expect(f.read(limits)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
  })

  it('checks the old file size too, even when the new file is small', async () => {
    const f = fixture('x'.repeat(100), 'small')
    await expect(f.read({ maxFileBytes: 20 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
  })

  it.each(['oldFile', 'newFile'] as const)(
    'rejects a valid but wrong blob returned for %s',
    async (side) => {
      const f = fixture()
      Object.assign(f[side], file('a different commit version'))
      await expect(f.read()).rejects.toMatchObject({ code: 'INVALID_GITHUB_RESPONSE' })
    },
  )

  it.each([
    ['line without newline', 'changed without newline'],
    ['# 标题\r\n旧内容\r\n', '# 标题\r\n新内容\r\n'],
    ['line\n', 'line'],
    ['', '新增\n'],
    ['删除\n', ''],
  ])('produces a reversible exact diff for %j → %j', async (oldContent, newContent) => {
    const result = await fixture(oldContent, newContent).read()
    if (result.status !== 'COLLECTED' || result.evidence.diff === null)
      throw new Error('Expected Diff evidence')
    expect(result.evidence.content).toBe(newContent)
    expect(result.evidence.contentHash).toBe(createHash('sha256').update(newContent).digest('hex'))
    expect(applyPatch(oldContent, result.evidence.diff, { autoConvertLineEndings: false })).toBe(
      newContent,
    )
  })

  it('bounds computation for many entirely different lines instead of blocking without a limit', async () => {
    const f = fixture('a\n'.repeat(6000), 'b\n'.repeat(6000))
    await expect(f.read()).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
  })
})
