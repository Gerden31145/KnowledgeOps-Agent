import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  readCommitEvidence,
  type CommitEvidenceLimits,
} from '../src/github/read-commit-evidence.js'
import { MAX_GITHUB_EVIDENCE_RESPONSE_BYTES } from '../src/github/github-evidence-http.js'

// 全部是合成数据；不请求真实 GitHub，不读取 .env，也不接数据库或队列。
const BEFORE = 'a'.repeat(40)
const AFTER = 'b'.repeat(40)
const INPUT = {
  githubRepositoryId: '123',
  beforeCommitSha: BEFORE,
  afterCommitSha: AFTER,
  targetPath: 'notes/vue.md',
}
const TOKEN = 'installation-token-fixture-not-real'
const CONTENT = '# Vue\nB 的正文\n'
const PATCH = '@@ -1,2 +1,2 @@\n # Vue\n-A 的正文\n+B 的正文'

function fileResponse(bytes = Buffer.from(CONTENT)) {
  return {
    type: 'file',
    path: INPUT.targetPath,
    sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
    size: bytes.length,
    encoding: 'base64',
    content: bytes.toString('base64'),
  }
}

interface Change {
  filename: string
  sha: string
  status: string
  additions: number
  deletions: number
  patch?: string
  previous_filename?: string
}

function fixture() {
  const file = fileResponse()
  const changed: Change = {
    filename: INPUT.targetPath,
    sha: file.sha,
    status: 'modified',
    additions: 1,
    deletions: 1,
    patch: PATCH,
  }
  const comparison = {
    base_commit: { sha: BEFORE },
    merge_base_commit: { sha: BEFORE },
    files: [changed],
  }
  const repository = { id: 123, full_name: 'student/notes' }
  // 分支已经推进到 C：如果实现误用 main/默认分支，拿到的就会是这一份。
  const latestFile = fileResponse(Buffer.from('# Vue\nC 的正文\n'))
  const fetchGitHub = vi.fn<typeof fetch>(async (url) => {
    const request = new URL(String(url))
    if (request.pathname === '/repositories/123') return Response.json(repository)
    if (request.pathname.includes('/compare/')) return Response.json(comparison)
    const ref = request.searchParams.get('ref')
    return Response.json(ref === BEFORE || ref === AFTER ? file : latestFile)
  })
  const read = (limits: CommitEvidenceLimits = {}) =>
    readCommitEvidence(INPUT, { installationToken: TOKEN, fetchGitHub, limits })
  return { file, changed, comparison, repository, fetchGitHub, read }
}

describe('R06 fixed-commit evidence reader (synthetic GitHub responses)', () => {
  it('reads B even when main points to C, returning complete content, diff, hash and line count', async () => {
    const f = fixture()
    await expect(f.read()).resolves.toEqual({
      status: 'COLLECTED',
      evidence: {
        ...INPUT,
        previousPath: null,
        change: 'modified',
        sourceCommitSha: AFTER,
        content: CONTENT,
        contentHash: createHash('sha256').update(CONTENT).digest('hex'),
        lineCount: 2,
        diff: PATCH,
      },
    })
    expect(f.fetchGitHub.mock.calls.map(([url]) => url)).toEqual([
      'https://api.github.com/repositories/123',
      `https://api.github.com/repos/student/notes/compare/${BEFORE}...${AFTER}?per_page=1&page=1`,
      `https://api.github.com/repos/student/notes/contents/notes/vue.md?ref=${AFTER}`,
    ])
    const firstSignal = f.fetchGitHub.mock.calls[0]?.[1]?.signal
    expect(firstSignal).toBeInstanceOf(AbortSignal)
    for (const [, options] of f.fetchGitHub.mock.calls) {
      expect(options).toMatchObject({
        method: 'GET',
        redirect: 'error',
        signal: firstSignal,
        headers: { authorization: `Bearer ${TOKEN}` },
      })
    }
  })

  it('captures a deletion from before without reading missing after content or declaring task failure', async () => {
    const f = fixture()
    Object.assign(f.changed, {
      status: 'removed',
      additions: 0,
      deletions: 2,
      patch: '@@ -1,2 +0,0 @@\n-# Vue\n-B 的正文',
    })
    await expect(f.read()).resolves.toMatchObject({
      status: 'COLLECTED',
      evidence: { change: 'removed', sourceCommitSha: BEFORE, content: CONTENT },
    })
    expect(f.fetchGitHub.mock.lastCall?.[0]).toContain(`?ref=${BEFORE}`)
  })

  it.each([
    ['no changed files', 'NO_MARKDOWN_CHANGE'],
    ['only JavaScript changed', 'NO_MARKDOWN_CHANGE'],
    ['another Markdown changed', 'TARGET_NOT_CHANGED'],
    ['target renamed away', 'TARGET_RENAMED'],
  ])('does not fetch unrelated content: %s', async (scenario, reason) => {
    const f = fixture()
    if (scenario === 'no changed files') f.comparison.files = []
    if (scenario === 'only JavaScript changed') f.changed.filename = 'index.js'
    if (scenario === 'another Markdown changed') f.changed.filename = 'notes/other.md'
    if (scenario === 'target renamed away')
      Object.assign(f.changed, {
        filename: 'notes/renamed.md',
        previous_filename: INPUT.targetPath,
        status: 'renamed',
      })
    await expect(f.read()).resolves.toEqual({ status: 'IGNORED', reason })
    expect(f.fetchGitHub).toHaveBeenCalledTimes(2)
  })

  it('keeps the previous path when a renamed file now matches the selected target', async () => {
    const f = fixture()
    Object.assign(f.changed, { status: 'renamed', previous_filename: 'notes/old.md' })
    await expect(f.read()).resolves.toMatchObject({
      status: 'COLLECTED',
      evidence: { change: 'renamed', previousPath: 'notes/old.md', sourceCommitSha: AFTER },
    })
  })

  it('encodes a repository-relative path containing Unicode, spaces, # and ? without changing the SHA', async () => {
    const f = fixture()
    const targetPath = '笔记/vue #1?.md'
    f.changed.filename = targetPath
    f.file.path = targetPath
    await expect(
      readCommitEvidence(
        { ...INPUT, targetPath },
        {
          installationToken: TOKEN,
          fetchGitHub: f.fetchGitHub,
        },
      ),
    ).resolves.toMatchObject({ status: 'COLLECTED', evidence: { targetPath } })
    expect(f.fetchGitHub.mock.lastCall?.[0]).toContain(
      `/contents/${targetPath.split('/').map(encodeURIComponent).join('/')}?ref=${AFTER}`,
    )
  })

  it.each([
    { maxChangedFiles: 1 },
    { maxMarkdownFiles: 1 },
    { maxFileBytes: 2 },
    { maxDiffCharacters: 2 },
  ])('rejects limits rather than producing partial evidence: %j', async (limits) => {
    const f = fixture()
    f.comparison.files.push({ ...f.changed, filename: 'notes/other.md' })
    await expect(f.read(limits)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
  })

  it('refuses the Compare API 300-file boundary even when the selected file was returned', async () => {
    const f = fixture()
    f.comparison.files.push(
      ...Array.from({ length: 299 }, (_, index) => ({
        ...f.changed,
        filename: `file-${index}.txt`,
        patch: '',
        additions: 0,
        deletions: 0,
      })),
    )
    await expect(f.read({ maxChangedFiles: 299 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    expect(f.fetchGitHub).toHaveBeenCalledTimes(2)
  })

  it.each(['missing', 'truncated'])('refuses %s target patches', async (kind) => {
    const f = fixture()
    if (kind === 'missing') delete f.changed.patch
    else f.changed.patch = '@@ -1,2 +1,2 @@\n # Vue\n-A 的正文'
    await expect(f.read()).rejects.toMatchObject({ code: 'INCOMPLETE_DIFF' })
    expect(f.fetchGitHub).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['', 0],
    ['# Vue\r\n正文\r\n', 2],
    ['# Vue\n\n', 2],
    ['\n', 1],
  ] as const)(
    'preserves exact content bytes and counts lines for %j',
    async (content, lineCount) => {
      const f = fixture()
      Object.assign(f.file, fileResponse(Buffer.from(content)))
      Object.assign(f.changed, {
        sha: f.file.sha,
        status: 'added',
        additions: lineCount,
        deletions: 0,
        patch:
          lineCount === 0
            ? ''
            : `@@ -0,0 +1,${lineCount} @@\n${content
                .replace(/\r?\n$/, '')
                .split(/\r?\n/)
                .map((line) => `+${line}`)
                .join('\n')}`,
      })
      await expect(f.read()).resolves.toMatchObject({
        status: 'COLLECTED',
        evidence: {
          content,
          lineCount,
          contentHash: createHash('sha256').update(content).digest('hex'),
        },
      })
    },
  )

  it.each(['path', 'size', 'sha', 'base64'])('rejects inconsistent file %s', async (field) => {
    const f = fixture()
    if (field === 'path') f.file.path = 'other.md'
    if (field === 'size') f.file.size += 1
    if (field === 'sha') f.file.sha = 'c'.repeat(40)
    if (field === 'base64') f.file.content += '!'
    await expect(f.read()).rejects.toMatchObject({ code: 'INVALID_GITHUB_RESPONSE' })
  })

  it('rejects a blob that does not match the comparison, rather than accepting another file version', async () => {
    const f = fixture()
    Object.assign(f.file, fileResponse(Buffer.from('# Vue\nC 的正文\n')))
    await expect(f.read()).rejects.toMatchObject({ code: 'INVALID_GITHUB_RESPONSE' })
  })

  it.each([Buffer.from([0xff]), Buffer.from('binary\0data')])(
    'rejects non-text target content',
    async (bytes) => {
      const f = fixture()
      Object.assign(f.file, fileResponse(bytes))
      f.changed.sha = f.file.sha
      await expect(f.read()).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE' })
    },
  )

  it('refuses symlinks and other non-file responses', async () => {
    const f = fixture()
    f.file.type = 'symlink'
    await expect(f.read()).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE' })
  })

  it('refuses a repository ID mismatch before asking for private commit content', async () => {
    const f = fixture()
    f.repository.id = 456
    await expect(f.read()).rejects.toMatchObject({ code: 'INVALID_GITHUB_RESPONSE' })
    expect(f.fetchGitHub).toHaveBeenCalledTimes(1)
  })

  it('rejects a comparison for a different before commit', async () => {
    const f = fixture()
    f.comparison.base_commit.sha = 'c'.repeat(40)
    await expect(f.read()).rejects.toMatchObject({ code: 'INVALID_GITHUB_RESPONSE' })
    expect(f.fetchGitHub).toHaveBeenCalledTimes(2)
  })

  it.each([
    [{ afterCommitSha: 'main' }, 'INVALID_INPUT'],
    [{ beforeCommitSha: '0'.repeat(40) }, 'RESYNC_REQUIRED'],
    [{ targetPath: '../private.md' }, 'INVALID_INPUT'],
    [{ targetPath: 'notes/./vue.md' }, 'INVALID_INPUT'],
  ] as const)('rejects an unsafe source before any network call: %j', async (overrides, code) => {
    const f = fixture()
    await expect(
      readCommitEvidence(
        { ...INPUT, ...overrides },
        {
          installationToken: TOKEN,
          fetchGitHub: f.fetchGitHub,
        },
      ),
    ).rejects.toMatchObject({ code })
    expect(f.fetchGitHub).not.toHaveBeenCalled()
  })

  it('requires a caller-provided installation credential and validates configured limits', async () => {
    const f = fixture()
    await expect(
      readCommitEvidence(INPUT, {
        installationToken: '',
        fetchGitHub: f.fetchGitHub,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(f.read({ maxChangedFiles: 300 })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(f.fetchGitHub).not.toHaveBeenCalled()
  })

  it.each([
    [401, 'GITHUB_AUTH_REQUIRED'],
    [403, 'GITHUB_UNAVAILABLE'],
    [404, 'SOURCE_UNAVAILABLE'],
    [429, 'GITHUB_UNAVAILABLE'],
    [503, 'GITHUB_UNAVAILABLE'],
  ])('maps HTTP %i to a safe code without copying its response', async (status, code) => {
    const f = fixture()
    f.fetchGitHub.mockResolvedValueOnce(
      new Response('private upstream details', { status: Number(status) }),
    )
    await expect(f.read()).rejects.toMatchObject({ code, message: code })
    expect(f.fetchGitHub).toHaveBeenCalledTimes(1)
  })

  it('never falls back to main when pinned content is unavailable', async () => {
    const f = fixture()
    f.fetchGitHub
      .mockResolvedValueOnce(Response.json(f.repository))
      .mockResolvedValueOnce(Response.json(f.comparison))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
    await expect(f.read()).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' })
    expect(f.fetchGitHub).toHaveBeenCalledTimes(3)
    expect(f.fetchGitHub.mock.lastCall?.[0]).toContain(`?ref=${AFTER}`)
  })

  it('sanitizes network failures instead of leaking an upstream message or credential', async () => {
    const f = fixture()
    f.fetchGitHub.mockRejectedValueOnce(new Error(`failed with ${TOKEN}`))
    await expect(f.read()).rejects.toMatchObject({
      code: 'GITHUB_UNAVAILABLE',
      message: 'GITHUB_UNAVAILABLE',
    })
  })

  it('rejects malformed JSON without exposing the body', async () => {
    const f = fixture()
    f.fetchGitHub.mockResolvedValueOnce(new Response('private malformed JSON'))
    await expect(f.read()).rejects.toMatchObject({ code: 'INVALID_GITHUB_RESPONSE' })
  })

  it('cancels an oversized response even when Content-Length underreports its size', async () => {
    const f = fixture()
    const cancel = vi.fn()
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_GITHUB_EVIDENCE_RESPONSE_BYTES + 1))
      },
      cancel,
    })
    f.fetchGitHub.mockResolvedValueOnce(new Response(body, { headers: { 'content-length': '1' } }))
    await expect(f.read()).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    expect(cancel).toHaveBeenCalledOnce()
  })
})
