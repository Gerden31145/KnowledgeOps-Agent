import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { findRequiredSection } from '../src/verification/find-required-section.exercise.js'
import { parseNoteEvidence } from '../src/verification/parse-note-evidence.js'
import { checkNoteCriteria } from '../src/verification/check-note-criteria.js'
import { noteEvidence } from '../test/fixtures/note-evidence.js'

function find(content: string, heading = '事件循环') {
  return findRequiredSection(parseNoteEvidence(noteEvidence(content)).tree, heading)
}

describe('R08 small handwrite: locate the required document heading', () => {
  it('returns original heading lines after leading blank lines', () => {
    expect(find('\n## 事件循环\n\n正文')).toEqual({ startLine: 2, endLine: 2 })
  })

  it('recognizes text in formatted headings without treating image alt as heading text', () => {
    expect(find('## **事件**`循环`\n')).toEqual({ startLine: 1, endLine: 1 })
    expect(find('## ![事件循环](image.png)\n')).toBeNull()
  })

  it('requires an exact case-sensitive text match', () => {
    expect(find('## 浏览器事件循环')).toBeNull()
    expect(find('## Event Loop', 'event loop')).toBeNull()
  })

  it('ignores mentions in paragraphs, code, HTML and quoted sample headings', () => {
    expect(
      find(
        '正文提到了事件循环。\n\n```md\n## 事件循环\n```\n\n<h2>事件循环</h2>\n\n> ## 事件循环\n',
      ),
    ).toBeNull()
    expect(find('')).toBeNull()
  })

  it('returns the first match, including a two-line Setext heading', () => {
    expect(find('事件循环\n--------\n\n## 事件循环\n')).toEqual({ startLine: 1, endLine: 2 })
  })

  it('connects a location or absence to the real checker and source citation', () => {
    const criterion = {
      id: randomUUID(),
      type: 'SECTION_PRESENT' as const,
      config: { heading: '事件循环' },
    }
    const evidence = noteEvidence('\n## 事件循环\n\n正文')
    const present = checkNoteCriteria({ evidence, criteria: [criterion] }).results[0]!
    expect(present).toMatchObject({ criterionId: criterion.id, outcome: 'PASSED', suggestions: [] })
    expect(present.citations).toEqual([
      {
        repositoryId: evidence.repositoryId,
        commitSha: evidence.sourceCommitSha,
        contentHash: evidence.contentHash,
        path: evidence.path,
        startLine: 2,
        endLine: 2,
        excerpt: '## 事件循环',
      },
    ])
    const absent = checkNoteCriteria({
      evidence: noteEvidence('# 其他章节'),
      criteria: [criterion],
    }).results[0]!
    expect(absent).toMatchObject({ criterionId: criterion.id, outcome: 'FAILED', citations: [] })
  })
})
