import { describe, expect, it } from 'vitest'

import {
  InvalidPlanGenerationOutputError,
  InvalidPlanGenerationRequestError,
  generatePlanCandidate,
  planGenerationOutputSchema,
  planGenerationRequestSchema,
  type PlanGenerationPort,
} from '../src/index.js'
import {
  validPlanGenerationOutput,
  validPlanGenerationRequest,
} from './fixtures/plan-generation.js'

describe('plan generation domain contract', () => {
  it('rejects a course without knowledge points at the model port boundary', async () => {
    const incomplete = structuredClone(validPlanGenerationOutput)
    Object.assign(incomplete.stages[0]!.tasks[0]!, { knowledgePoints: [] })
    await expect(
      generatePlanCandidate({ generate: async () => incomplete }, validPlanGenerationRequest),
    ).rejects.toBeInstanceOf(InvalidPlanGenerationOutputError)
  })

  it('accepts a bounded course plan and a future goal deadline', () => {
    expect(planGenerationRequestSchema.parse(validPlanGenerationRequest)).toEqual(
      validPlanGenerationRequest,
    )
    expect(planGenerationOutputSchema.parse(validPlanGenerationOutput)).toEqual(
      validPlanGenerationOutput,
    )
  })

  it('rejects a stale or overlong goal date at the model port boundary', () => {
    for (const deadline of ['2026-08-10', '2026-08-09', '2026-11-09']) {
      const result = planGenerationRequestSchema.safeParse({
        ...validPlanGenerationRequest,
        goal: { ...validPlanGenerationRequest.goal, deadline },
      })
      expect(result.success).toBe(false)
      if (!result.success)
        expect(result.error.issues.some((issue) => issue.path.join('.') === 'goal.deadline')).toBe(
          true,
        )
    }
  })

  it('rejects fewer than three or more than eight courses in total', () => {
    const oneTask = {
      stages: [
        {
          ...validPlanGenerationOutput.stages[0],
          tasks: [validPlanGenerationOutput.stages[0].tasks[0]],
        },
      ],
    }
    const nineTasks = {
      stages: [
        {
          ...validPlanGenerationOutput.stages[0],
          tasks: Array.from({ length: 9 }, (_, index) => ({
            ...validPlanGenerationOutput.stages[0].tasks[0],
            id: `task-${index + 1}`,
          })),
        },
      ],
    }
    expect(planGenerationOutputSchema.safeParse(oneTask).success).toBe(false)
    expect(planGenerationOutputSchema.safeParse(nineTasks).success).toBe(false)
  })

  it('rejects conflicting definitions for a reused knowledge point ID', () => {
    const conflicting = structuredClone(validPlanGenerationOutput)
    const task = conflicting.stages[0]!.tasks[1]!
    Object.assign(task, {
      knowledgePoints: task.knowledgePoints.map((point, index) =>
        index === 0 ? { ...point, title: '不同的事件循环定义' } : point,
      ),
    })
    expect(planGenerationOutputSchema.safeParse(conflicting).success).toBe(false)
  })

  it('does not allow the new generation entry to produce legacy note tasks', async () => {
    const legacy = structuredClone(validPlanGenerationOutput)
    Object.assign(legacy.stages[0].tasks[0], { type: 'MARKDOWN_NOTE' })
    await expect(
      generatePlanCandidate({ generate: async () => legacy }, validPlanGenerationRequest),
    ).rejects.toBeInstanceOf(InvalidPlanGenerationOutputError)
  })

  it('makes Fake and production adapters pass through the same validation boundary', async () => {
    const validFake: PlanGenerationPort = { generate: async () => validPlanGenerationOutput }
    const invalidFake: PlanGenerationPort = { generate: async () => ({ stages: [] }) }
    await expect(generatePlanCandidate(validFake, validPlanGenerationRequest)).resolves.toEqual(
      validPlanGenerationOutput,
    )
    await expect(
      generatePlanCandidate(invalidFake, validPlanGenerationRequest),
    ).rejects.toBeInstanceOf(InvalidPlanGenerationOutputError)
    await expect(
      generatePlanCandidate(validFake, {
        ...validPlanGenerationRequest,
        goal: { ...validPlanGenerationRequest.goal, deadline: '2026-08-10' },
      }),
    ).rejects.toBeInstanceOf(InvalidPlanGenerationRequestError)
  })
})
