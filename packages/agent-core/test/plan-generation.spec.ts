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
  it('accepts a bounded plan and a future goal deadline', () => {
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
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path.join('.') === 'goal.deadline')).toBe(
          true,
        )
      }
    }
  })

  it('rejects fewer than three or more than eight tasks in total', () => {
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

  it('rejects unsafe or non-Markdown target paths and unsupported plan-time criteria', () => {
    const baseTask = validPlanGenerationOutput.stages[0].tasks[0]

    for (const targetPath of ['/absolute/note.md', '../outside.md', 'notes/plain.txt']) {
      expect(
        planGenerationOutputSchema.safeParse({
          stages: [
            {
              ...validPlanGenerationOutput.stages[0],
              tasks: [
                { ...baseTask, targetPath },
                validPlanGenerationOutput.stages[0].tasks[1],
                validPlanGenerationOutput.stages[0].tasks[2],
              ],
            },
          ],
        }).success,
      ).toBe(false)
    }

    expect(
      planGenerationOutputSchema.safeParse({
        stages: [
          {
            ...validPlanGenerationOutput.stages[0],
            tasks: [
              {
                ...baseTask,
                acceptanceCriteria: [
                  {
                    type: 'FOLLOW_UP_ANSWER',
                    description: 'This criterion only exists after note verification.',
                    required: true,
                  },
                ],
              },
              validPlanGenerationOutput.stages[0].tasks[1],
              validPlanGenerationOutput.stages[0].tasks[2],
            ],
          },
        ],
      }).success,
    ).toBe(false)
  })

  it('makes Fake and production adapters pass through the same validation boundary', async () => {
    const validFake: PlanGenerationPort = {
      generate: async () => validPlanGenerationOutput,
    }
    const invalidFake: PlanGenerationPort = {
      generate: async () => ({ stages: [] }),
    }

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
