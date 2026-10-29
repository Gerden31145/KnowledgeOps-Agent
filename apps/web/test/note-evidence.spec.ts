import { describe, expect, it } from 'vitest'
import { matchesNoteCitation, noteEvidenceLines } from '../app/lib/note-evidence'
import { noteEvidence } from './fixtures/note-verification'

const evidence = noteEvidence()
const lines = noteEvidenceLines(evidence)
const citation = {
  repositoryId: evidence.repositoryId,
  commitSha: evidence.sourceCommitSha,
  path: evidence.path,
  contentHash: evidence.contentHash,
  startLine: 2,
  endLine: 3,
  excerpt: '\nduration 表示持续时间。',
}
describe('fixed note evidence and citation locations', () => {
  it.each(['\r\n', '\n', '\r'])(
    'keeps blank lines and drops exactly one trailing %j newline',
    (newline) => {
      expect(
        noteEvidenceLines(
          noteEvidence({ content: newline + '正文' + newline + newline, lineCount: 3 }),
        ),
      ).toEqual(['', '正文', ''])
    },
  )
  it('distinguishes an empty file from a file containing a blank line', () => {
    expect(noteEvidenceLines(noteEvidence({ content: '', lineCount: 0 }))).toEqual([])
    expect(noteEvidenceLines(noteEvidence({ content: '\n', lineCount: 1 }))).toEqual([''])
  })
  it('rejects a persisted line count mismatch', () => {
    expect(() => noteEvidenceLines(noteEvidence({ lineCount: 4 }))).toThrow('行数不一致')
  })
  it('locates only the saved source and exact excerpt, without interpreting Markdown or HTML', () => {
    expect(matchesNoteCitation(evidence, lines, citation)).toBe(true)
    const html = '<img src=x onerror=alert(1)>'
    expect(noteEvidenceLines(noteEvidence({ content: html, lineCount: 1 }))).toEqual([html])
  })
  it.each([
    { repositoryId: evidence.taskId },
    { commitSha: 'd'.repeat(40) },
    { path: 'notes/other.md' },
    { contentHash: 'f'.repeat(64) },
    { startLine: 0 },
    { endLine: 4 },
    { endLine: 1 },
    { startLine: 2.5 },
    { excerpt: '捏造的引文' },
  ])('refuses a mismatched or out-of-range citation %j', (override) => {
    expect(matchesNoteCitation(evidence, lines, { ...citation, ...override })).toBe(false)
  })
})
