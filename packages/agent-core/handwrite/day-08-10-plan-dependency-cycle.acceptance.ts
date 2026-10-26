import { describe, expect, it } from 'vitest'

import { hasPlanGenerationDependencyCycle, type PlanGenerationOutput } from '../src/index.js'

type Edges = Readonly<Record<string, readonly string[]>>

function createPlan(edges: Edges): PlanGenerationOutput {
  return {
    stages: [
      {
        title: 'Dependency graph',
        tasks: Object.entries(edges).map(([id, dependsOnTaskIds], index) => ({
          id,
          title: `Task ${index + 1}`,
          description: `Explain dependency graph concept ${index + 1}.`,
          type: 'MARKDOWN_NOTE',
          estimatedMinutes: 60,
          suggestedSteps: ['Write one concrete explanation'],
          targetPath: `notes/${id}.md`,
          acceptanceCriteria: [
            {
              type: 'SECTION_PRESENT',
              config: { heading: '事件循环' },
              description: 'Contains the required explanation section.',
              required: true,
            },
          ],
          dependsOnTaskIds: [...dependsOnTaskIds],
        })),
      },
    ],
  }
}

describe('08-10 plan dependency cycle handwrite acceptance', () => {
  it('accepts a simple dependency chain', () => {
    expect(
      hasPlanGenerationDependencyCycle(
        createPlan({ foundation: [], browser: ['foundation'], vue: ['browser'] }),
      ),
    ).toBe(false)
  })

  it('accepts a diamond-shaped DAG with converging dependencies', () => {
    expect(
      hasPlanGenerationDependencyCycle(
        createPlan({
          foundation: [],
          browser: ['foundation'],
          vue: ['foundation'],
          project: ['browser', 'vue'],
        }),
      ),
    ).toBe(false)
  })

  it('detects a two-task cycle', () => {
    expect(
      hasPlanGenerationDependencyCycle(
        createPlan({ first: ['second'], second: ['first'], independent: [] }),
      ),
    ).toBe(true)
  })

  it('detects a longer cycle', () => {
    expect(
      hasPlanGenerationDependencyCycle(
        createPlan({ first: ['third'], second: ['first'], third: ['second'] }),
      ),
    ).toBe(true)
  })

  it('detects a cycle inside one disconnected component', () => {
    expect(
      hasPlanGenerationDependencyCycle(
        createPlan({
          root: [],
          leaf: ['root'],
          cycleA: ['cycleB'],
          cycleB: ['cycleA'],
        }),
      ),
    ).toBe(true)
  })

  it('checks dependencies across stages without mutating the candidate', () => {
    const plan = createPlan({ first: ['third'], second: ['first'], third: ['second'] })
    plan.stages = [
      { ...plan.stages[0]!, tasks: plan.stages[0]!.tasks.slice(0, 1) },
      { ...plan.stages[0]!, title: 'Second stage', tasks: plan.stages[0]!.tasks.slice(1) },
    ]
    const before = structuredClone(plan)

    expect(hasPlanGenerationDependencyCycle(plan)).toBe(true)
    expect(plan).toEqual(before)
  })
})
