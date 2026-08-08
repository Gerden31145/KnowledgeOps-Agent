import { describe, expect, it } from 'vitest'

import { createLearningGoalInputSchema, LEARNING_GOAL_INPUT_LIMITS } from '../src/index.js'

const TODAY = '2026-08-08'

const validInput = {
  title: '掌握 NestJS 的核心后端开发流程',
  currentLevel: '熟悉 Vue 3 和 TypeScript，但不熟悉后端架构与数据库。',
  deadline: '2026-09-30',
  weeklyMinutes: 600,
}

describe('LearningGoal input Schema handwrite acceptance', () => {
  const schema = createLearningGoalInputSchema(TODAY)

  it('accepts a valid goal and trims user-authored strings', () => {
    const result = schema.safeParse({
      ...validInput,
      title: `  ${validInput.title}  `,
      currentLevel: `  ${validInput.currentLevel}  `,
    })

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual(validInput)
    }
  })

  it('requires every field and rejects unknown fields', () => {
    for (const field of Object.keys(validInput)) {
      const inputMissingOneField = { ...validInput }
      Reflect.deleteProperty(inputMissingOneField, field)

      expect(schema.safeParse(inputMissingOneField).success).toBe(false)
    }

    expect(
      schema.safeParse({
        ...validInput,
        unexpectedField: true,
      }).success,
    ).toBe(false)
  })

  it('enforces the string length boundaries after trimming', () => {
    const { title, currentLevel } = LEARNING_GOAL_INPUT_LIMITS

    expect(schema.safeParse({ ...validInput, title: '   ' }).success).toBe(false)
    expect(schema.safeParse({ ...validInput, currentLevel: '   ' }).success).toBe(false)

    for (const length of [title.minLength, title.maxLength]) {
      expect(
        schema.safeParse({
          ...validInput,
          title: '字'.repeat(length),
        }).success,
      ).toBe(true)
    }

    for (const length of [currentLevel.minLength, currentLevel.maxLength]) {
      expect(
        schema.safeParse({
          ...validInput,
          currentLevel: '字'.repeat(length),
        }).success,
      ).toBe(true)
    }

    expect(
      schema.safeParse({
        ...validInput,
        title: '字'.repeat(title.minLength - 1),
      }).success,
    ).toBe(false)
    expect(
      schema.safeParse({
        ...validInput,
        title: '字'.repeat(title.maxLength + 1),
      }).success,
    ).toBe(false)
    expect(
      schema.safeParse({
        ...validInput,
        currentLevel: '字'.repeat(currentLevel.minLength - 1),
      }).success,
    ).toBe(false)
    expect(
      schema.safeParse({
        ...validInput,
        currentLevel: '字'.repeat(currentLevel.maxLength + 1),
      }).success,
    ).toBe(false)
  })

  it('accepts only integer weekly minutes inside the configured range', () => {
    const { min, max } = LEARNING_GOAL_INPUT_LIMITS.weeklyMinutes

    for (const weeklyMinutes of [min, max]) {
      expect(schema.safeParse({ ...validInput, weeklyMinutes }).success).toBe(true)
    }

    for (const weeklyMinutes of [min - 1, max + 1, 90.5, '600']) {
      expect(schema.safeParse({ ...validInput, weeklyMinutes }).success).toBe(false)
    }
  })

  it('rejects malformed, impossible, current, and past deadline dates', () => {
    for (const deadline of ['2026-8-09', '2026-02-29', TODAY, '2026-08-07']) {
      const result = schema.safeParse({ ...validInput, deadline })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.flatten().fieldErrors.deadline).toBeDefined()
      }
    }
  })

  it('accepts the 90-day deadline boundary and rejects day 91', () => {
    expect(
      schema.safeParse({
        ...validInput,
        deadline: '2026-11-06',
      }).success,
    ).toBe(true)

    const result = schema.safeParse({
      ...validInput,
      deadline: '2026-11-07',
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.deadline).toBeDefined()
    }
  })
})
