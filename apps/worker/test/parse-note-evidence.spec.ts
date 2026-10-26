import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseNoteEvidence, readNoteCitation } from '../src/verification/parse-note-evidence.js'

function input(content: string) {
  return {
    repositoryId: '11111111-1111-4111-8111-111111111111',
    path: 'notes/event-loop.md',
    sourceCommitSha: 'b'.repeat(40),
    content,
    contentHash: createHash('sha256').update(content, 'utf8').digest('hex'),
    lineCount:
      content === '' ? 0 : content.replace(/(?:\r\n|\n|\r)$/, '').split(/\r\n|\n|\r/).length,
  }
}

describe('fixed note evidence parsing and citations', () => {
  it('distinguishes a real heading from heading syntax inside a code block', () => {
    const note = parseNoteEvidence(input('## 事件循环\n\n```md\n## 示例标题\n```\n'))
    expect(note.tree.children.map((node) => node.type)).toEqual(['heading', 'code'])
    expect(note.tree.children[1]?.position).toMatchObject({
      start: { line: 3 },
      end: { line: 5 },
    })
  })

  it.each(['\n', '\r\n', '\r'])(
    'preserves leading blank lines and source offsets with %j',
    (eol) => {
      const content = ['', '## 事件循环', '', '微任务示例 😀', ''].join(eol)
      const note = parseNoteEvidence(input(content))
      expect(note.tree.children[0]?.position?.start).toMatchObject({ line: 2, offset: eol.length })
      expect(readNoteCitation(note, 2, 4)).toEqual({
        repositoryId: input(content).repositoryId,
        commitSha: 'b'.repeat(40),
        path: 'notes/event-loop.md',
        startLine: 2,
        endLine: 4,
        excerpt: '## 事件循环\n\n微任务示例 😀',
        contentHash: input(content).contentHash,
      })
    },
  )

  it('rejects content/hash or line count mismatch instead of quoting different evidence', () => {
    const evidence = input('## 原正文')
    expect(() => parseNoteEvidence({ ...evidence, content: '## 被替换的正文' })).toThrow(
      'INVALID_EVIDENCE',
    )
    expect(() => parseNoteEvidence({ ...evidence, lineCount: 2 })).toThrow('INVALID_EVIDENCE')
  })

  it('keeps empty content empty and does not invent a citable first line', () => {
    const note = parseNoteEvidence(input(''))
    expect(note.tree.children).toEqual([])
    expect(() => readNoteCitation(note, 1, 1)).toThrow('INVALID_CITATION')
  })

  it.each([
    [0, 1],
    [2, 1],
    [1, 3],
    [1.5, 2],
    [1, NaN],
  ])('rejects invalid citation %j..%j', (start, end) => {
    expect(() => readNoteCitation(parseNoteEvidence(input('# 标题\n正文')), start, end)).toThrow(
      'INVALID_CITATION',
    )
  })

  it('rejects invalid source metadata, null bytes and files above the R06 maximum', () => {
    expect(() => parseNoteEvidence({ ...input('# 标题'), sourceCommitSha: 'main' })).toThrow(
      'INVALID_EVIDENCE',
    )
    expect(() => parseNoteEvidence({ ...input('# 标题'), path: '../secret.md' })).toThrow(
      'INVALID_EVIDENCE',
    )
    expect(() => parseNoteEvidence(input('正文\0'))).toThrow('INVALID_EVIDENCE')
    expect(() => parseNoteEvidence(input('a'.repeat(1_000_001)))).toThrow('INVALID_EVIDENCE')
  })
})
