import { describe, expect, it } from 'vitest'
import { generatedAcceptanceCriterionSchema } from '../src/domain/criterion-config.js'

const criterion = { type: 'SECTION_PRESENT', description: '笔记包含事件循环章节。', required: true }

describe('generated criterion parameters', () => {
  it('keeps a concrete heading or positive content threshold', () => {
    expect(
      generatedAcceptanceCriterionSchema.parse({
        ...criterion,
        config: { heading: '  事件循环  ' },
      }).config,
    ).toEqual({ heading: '事件循环' })
    expect(
      generatedAcceptanceCriterionSchema.parse({
        ...criterion,
        type: 'CONTENT_MINIMUM',
        description: '正文与代码至少包含 200 个非空白字符。',
        config: { minCharacters: 200 },
      }).config,
    ).toEqual({ minCharacters: 200 })
  })

  it.each([
    undefined,
    null,
    {},
    { heading: '' },
    { heading: '一\n二' },
    { minCharacters: 200 },
    { heading: '事件循环', extra: true },
  ])('rejects absent, ambiguous or mismatched section config %j', (config) => {
    expect(generatedAcceptanceCriterionSchema.safeParse({ ...criterion, config }).success).toBe(
      false,
    )
  })

  it.each([0, -1, 1.5, 10_001, '200'])(
    'rejects an invalid content threshold %j',
    (minCharacters) => {
      expect(
        generatedAcceptanceCriterionSchema.safeParse({
          ...criterion,
          type: 'CONTENT_MINIMUM',
          config: { minCharacters },
        }).success,
      ).toBe(false)
    },
  )

  it('requires null for types that do not have deterministic parameters', () => {
    for (const type of [
      'FILE_CHANGED',
      'SEMANTIC_CORRECTNESS',
      'TOPIC_COVERAGE',
      'EXPLANATION_QUALITY',
    ]) {
      expect(
        generatedAcceptanceCriterionSchema.safeParse({ ...criterion, type, config: null }).success,
      ).toBe(true)
      expect(
        generatedAcceptanceCriterionSchema.safeParse({
          ...criterion,
          type,
          config: { heading: '事件循环' },
        }).success,
      ).toBe(false)
    }
  })
})
