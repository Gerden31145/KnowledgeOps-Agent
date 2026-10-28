import { randomUUID } from 'node:crypto'
import type { FollowUpQuestionCandidate } from '@knowledgeops/agent-core'
import { describe, expect, it } from 'vitest'
import { parseNoteEvidence } from '../src/verification/parse-note-evidence.js'
import { validateFollowUpQuestion } from '../src/verification/validate-follow-up-question.js'
import { noteEvidence } from './fixtures/note-evidence.js'

function fixture() {
  const note = parseNoteEvidence(
    noteEvidence('# 事件循环\r\n\r\n当前任务结束后，先清空微任务队列。\r\n'),
  )
  const candidate: FollowUpQuestionCandidate = {
    question: '如果一个微任务又加入一个微任务，它与已排队的定时器谁先执行？请解释原因。',
    rubric: [
      '说明微任务队列会在当前检查点持续处理到清空。',
      '据此说明新加入的微任务仍早于后续的定时器任务。',
    ],
    citations: [{ startLine: 3, endLine: 3, excerpt: note.lines[2]! }],
  }
  return {
    source: {
      taskId: randomUUID(),
      submissionId: randomUUID(),
      noteRunId: randomUUID(),
      reportId: randomUUID(),
    },
    criterion: { id: randomUUID(), type: 'FOLLOW_UP_ANSWER' as const },
    note,
    candidate,
  }
}

describe('R10: one follow-up question bound to its original note', () => {
  it('keeps the question, rubric and exact source together without producing a passing result', () => {
    const input = fixture()
    const before = structuredClone(input)
    const question = validateFollowUpQuestion(input)
    expect(question).toEqual({
      ...input.candidate,
      criterionId: input.criterion.id,
      source: { ...input.source, ...input.note.source },
      citations: [{ ...input.note.source, ...input.candidate.citations[0] }],
    })
    expect(question).not.toHaveProperty('outcome')
    expect(input).toEqual(before)
  })

  it('keeps two submissions of the same path separate even when their text is identical', () => {
    const first = fixture()
    const firstQuestion = validateFollowUpQuestion(first)
    const second = fixture()
    second.source.taskId = first.source.taskId
    second.criterion.id = first.criterion.id
    second.note = parseNoteEvidence({
      ...noteEvidence(first.note.lines.join('\n')),
      sourceCommitSha: 'c'.repeat(40),
    })
    const secondQuestion = validateFollowUpQuestion(second)
    expect(firstQuestion.source.commitSha).toBe('b'.repeat(40))
    expect(secondQuestion.source.commitSha).toBe('c'.repeat(40))
    expect(firstQuestion.source.submissionId).not.toBe(secondQuestion.source.submissionId)
    expect(firstQuestion.source.reportId).not.toBe(secondQuestion.source.reportId)
    // 固定来源不等于已实现旧题拒绝；提交回答时还需要查询当前有效的笔记上下文。
  })

  it.each([
    { question: ' ' },
    { question: 'x'.repeat(1_001) },
    { rubric: [] },
    { rubric: [' '] },
    { rubric: ['x'.repeat(501)] },
    { rubric: Array.from({ length: 6 }, () => '评分要点') },
    { citations: [] },
    { questions: ['问题一', '问题二'] },
    { taskId: randomUUID() },
    { source: { commitSha: 'c'.repeat(40) } },
    { outcome: 'PASSED' },
  ])('rejects malformed or model-selected business fields %j', (change) => {
    const input = fixture()
    expect(() =>
      validateFollowUpQuestion({ ...input, candidate: { ...input.candidate, ...change } }),
    ).toThrow('INVALID_FOLLOW_UP_OUTPUT')
  })

  it.each([
    { startLine: 3, endLine: 3, excerpt: '编造的原文' },
    { startLine: 1, endLine: 1, excerpt: '当前任务结束后，先清空微任务队列。' },
    { startLine: 2, endLine: 2, excerpt: '' },
    { startLine: 3, endLine: 2, excerpt: '倒置行号' },
    { startLine: 3, endLine: 4, excerpt: '超出原文' },
  ])('rejects ungrounded questions: $excerpt', (citation) => {
    const input = fixture()
    input.candidate.citations.push(citation)
    expect(() => validateFollowUpQuestion(input)).toThrow('INVALID_FOLLOW_UP_CITATION')
  })

  it('does not let the model change the source of a valid quote', () => {
    const input = fixture()
    Object.assign(input.candidate.citations[0]!, { commitSha: 'c'.repeat(40) })
    expect(() => validateFollowUpQuestion(input)).toThrow('INVALID_FOLLOW_UP_OUTPUT')
  })

  it('requires a real follow-up criterion rather than a note semantic criterion', () => {
    const input = fixture()
    expect(() =>
      validateFollowUpQuestion({
        ...input,
        criterion: { ...input.criterion, type: 'SEMANTIC_CORRECTNESS' },
      }),
    ).toThrow('INVALID_FOLLOW_UP_CONTEXT')
  })

  it('rejects a missing report identity instead of returning an unbound question', () => {
    const input = fixture()
    expect(() =>
      validateFollowUpQuestion({ ...input, source: { ...input.source, reportId: '' } }),
    ).toThrow('INVALID_FOLLOW_UP_CONTEXT')
  })

  it('does not mistake authentic quotes for proof that the rubric is correct', () => {
    const input = fixture()
    input.candidate.rubric = ['错误的评分点：微任务必须等定时器执行完才处理。']
    expect(validateFollowUpQuestion(input).rubric).toEqual(input.candidate.rubric)
    // 结构与来源校验不证明出题质量；真实模型观察及固定评测仍有必要。
  })
})
