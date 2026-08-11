import { describe, expect, it } from 'vitest'

import { planGenerationOutputSchema } from '../src/index.js'
import { validPlanGenerationOutput } from '../test/fixtures/plan-generation.js'

function replaceTasks(tasks: unknown[]) {
  return {
    stages: [
      {
        ...validPlanGenerationOutput.stages[0],
        tasks,
      },
    ],
  }
}

describe('day 08-08 handwrite acceptance', () => {
  it('rejects duplicate task IDs across the complete plan', () => {
    const [first, second, third] = validPlanGenerationOutput.stages[0].tasks

    expect(
      planGenerationOutputSchema.safeParse(
        replaceTasks([first, { ...second, id: first.id }, third]),
      ).success,
    ).toBe(false)
  })

  it('rejects unknown dependency references', () => {
    const [first, second, third] = validPlanGenerationOutput.stages[0].tasks

    expect(
      planGenerationOutputSchema.safeParse(
        replaceTasks([first, { ...second, dependsOnTaskIds: ['missing-task'] }, third]),
      ).success,
    ).toBe(false)
  })

  it('rejects self dependencies', () => {
    const [first, second, third] = validPlanGenerationOutput.stages[0].tasks

    expect(
      planGenerationOutputSchema.safeParse(
        replaceTasks([first, { ...second, dependsOnTaskIds: [second.id] }, third]),
      ).success,
    ).toBe(false)
  })

  it('accepts a reference to a different known task', () => {
    expect(planGenerationOutputSchema.safeParse(validPlanGenerationOutput).success).toBe(true)
  })

  it('does not implement day 08-10 cycle detection early', () => {
    const [first, second, third] = validPlanGenerationOutput.stages[0].tasks
    const cycle = replaceTasks([
      { ...first, dependsOnTaskIds: [second.id] },
      { ...second, dependsOnTaskIds: [first.id] },
      third,
    ])

    expect(planGenerationOutputSchema.safeParse(cycle).success).toBe(true)
  })
})
