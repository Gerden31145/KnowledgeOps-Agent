import { randomUUID } from 'node:crypto'
import { criterionResultSchema, type AcceptanceCriterionType } from '@knowledgeops/contracts'
import { describe, expect, it } from 'vitest'
import { checkNoteCriteria } from '../src/verification/check-note-criteria.js'
import { noteEvidence } from './fixtures/note-evidence.js'

function criterion(type: AcceptanceCriterionType, config: unknown = null) {
  return { id: randomUUID(), type, config }
}

describe('deterministic note checks outside the R08 section handwrite', () => {
  it('handles an unclosed fence ending at EOF without citing a nonexistent trailing line', () => {
    const report = checkNoteCriteria({
      evidence: noteEvidence('```js\nx\n'),
      criteria: [criterion('CONTENT_MINIMUM', { minCharacters: 1 })],
    })
    expect(report.results[0]).toMatchObject({
      outcome: 'PASSED',
      citations: [expect.objectContaining({ startLine: 1, endLine: 2, excerpt: '```js\nx' })],
    })
  })
  it('counts prose and code by non-whitespace Unicode code points, excluding non-content nodes', () => {
    const evidence = noteEvidence(
      '# 不计标题\n\n甲 乙😀 [丙](https://example.test/long-url) `丁`\n\n```js\nx = 1\n```\n\n<div>不计 HTML 块</div>\n\n![不计图片说明](image.png)\n\n- 戊\n',
    )
    const report = checkNoteCriteria({
      evidence,
      criteria: [
        criterion('CONTENT_MINIMUM', { minCharacters: 9 }),
        criterion('CONTENT_MINIMUM', { minCharacters: 10 }),
      ],
    })
    expect(report.results.map((result) => result.outcome)).toEqual(['PASSED', 'FAILED'])
    expect(report.results[0]?.rationale).toContain('包含 9 个')
    for (const result of report.results) {
      expect(criterionResultSchema.safeParse(result).success).toBe(true)
      expect(result.citations.length).toBeGreaterThan(0)
      for (const citation of result.citations) {
        expect(citation).toMatchObject({
          commitSha: evidence.sourceCommitSha,
          contentHash: evidence.contentHash,
          path: evidence.path,
        })
        expect(citation.excerpt).toBe(
          evidence.content
            .split('\n')
            .slice(citation.startLine - 1, citation.endLine)
            .join('\n'),
        )
      }
    }
  })

  it.each([
    '',
    '# 只有标题\n\n',
    '<div>只有 HTML</div>',
    '![只有图片](image.png)',
    '```\n \t\n```',
  ])('does not count content in %j', (content) => {
    const report = checkNoteCriteria({
      evidence: noteEvidence(content),
      criteria: [criterion('CONTENT_MINIMUM', { minCharacters: 1 })],
    })
    expect(report.results[0]).toMatchObject({ outcome: 'FAILED', citations: [], confidence: 1 })
  })

  it.each([
    criterion('SECTION_PRESENT'),
    criterion('SECTION_PRESENT', { minCharacters: 20 }),
    criterion('CONTENT_MINIMUM'),
    criterion('CONTENT_MINIMUM', { minCharacters: 0 }),
  ])('keeps missing or wrong legacy parameters unresolved: $type', (item) => {
    const report = checkNoteCriteria({
      evidence: noteEvidence('## 事件循环\n\n足够长的内容'),
      criteria: [item],
    })
    expect(report.results).toEqual([
      expect.objectContaining({
        criterionId: item.id,
        outcome: 'INSUFFICIENT_EVIDENCE',
        confidence: 0,
        citations: [],
      }),
    ])
  })

  it.each(['added', 'modified', 'renamed'])(
    'uses persisted %s evidence for FILE_CHANGED and defers semantic judgments',
    (change) => {
      const file = criterion('FILE_CHANGED')
      const semantic = criterion('SEMANTIC_CORRECTNESS')
      const report = checkNoteCriteria({
        evidence: { ...noteEvidence('正文'), change },
        criteria: [file, semantic],
      })
      expect(report.results).toEqual([
        expect.objectContaining({ criterionId: file.id, outcome: 'PASSED' }),
      ])
      expect(report.pendingCriterionIds).toEqual([semantic.id])
    },
  )

  it('records the explicit SNAPSHOT exemption separately without treating it as passed', () => {
    const file = criterion('FILE_CHANGED')
    const report = checkNoteCriteria({
      evidence: { ...noteEvidence('正文'), mode: 'SNAPSHOT', change: null },
      criteria: [file, criterion('CONTENT_MINIMUM', { minCharacters: 2 })],
    })
    expect(report.exemptions).toEqual([
      { criterionId: file.id, reason: 'SNAPSHOT_FILE_CHANGED_NOT_APPLICABLE' },
    ])
    expect(report.results).toHaveLength(1)
    expect(report.results[0]?.outcome).toBe('PASSED')
  })

  it.each([
    { mode: 'DIFF', change: 'removed' },
    { mode: 'SNAPSHOT', change: 'modified' },
    { mode: 'UNKNOWN', change: null },
  ])('rejects non-current or inconsistent evidence %j', (metadata) => {
    expect(() =>
      checkNoteCriteria({
        evidence: { ...noteEvidence('# 旧正文'), ...metadata },
        criteria: [criterion('FILE_CHANGED')],
      }),
    ).toThrow('INVALID_EVIDENCE')
  })

  it('rejects corrupt content before checks and does not mutate any input', () => {
    const input = {
      evidence: noteEvidence('正文'),
      criteria: [criterion('CONTENT_MINIMUM', { minCharacters: 2 })],
    }
    const original = structuredClone(input)
    expect(checkNoteCriteria(input)).toEqual(checkNoteCriteria(input))
    expect(input).toEqual(original)
    expect(() =>
      checkNoteCriteria({ ...input, evidence: { ...input.evidence, content: '另一份内容' } }),
    ).toThrow('INVALID_EVIDENCE')
  })
})
