import { describe, it, expect } from 'vitest'
import { planGenerationOutputSchema } from '../src/index.js'

describe('plan generation dependency validation (day 08-08 handwrite)', () => {
  it('rejects duplicate task IDs across stages', () => {
    const plans = {
      stages: [
        {
          title: '测试标题',
          tasks: [
            {
              id: 'a123',
              title: 'test-task',
              description: 'xxxxxxxxxxxx',
              type: 'MARKDOWN_NOTE',
              estimatedMinutes: 123,
              suggestedSteps: ['step1', 'step2'],
              targetPath: 'path.md',
              acceptanceCriteria: [
                {
                  type: 'SECTION_PRESENT',
                  config: { heading: '事件循环' },
                  description: 'Contains a section comparing tasks and microtasks.',
                  required: true,
                },
                {
                  type: 'SEMANTIC_CORRECTNESS',
                  config: null,
                  description: 'Explains the ordering without reversing tasks and microtasks.',
                  required: true,
                },
              ],
              dependsOnTaskIds: [],
            },
            {
              id: 'a124',
              title: 'test-task2',
              description: 'xxxxxxxxxxxx',
              type: 'MARKDOWN_NOTE',
              estimatedMinutes: 123,
              suggestedSteps: ['step1', 'step2'],
              targetPath: 'path.md',
              acceptanceCriteria: [
                {
                  type: 'SECTION_PRESENT',
                  config: { heading: '事件循环' },
                  description: 'Contains a section comparing tasks and microtasks.',
                  required: true,
                },
                {
                  type: 'SEMANTIC_CORRECTNESS',
                  config: null,
                  description: 'Explains the ordering without reversing tasks and microtasks.',
                  required: true,
                },
              ],
              dependsOnTaskIds: [],
            },
            {
              id: 'a125',
              title: 'test-task3',
              description: 'xxxxxxxxxxxx',
              type: 'MARKDOWN_NOTE',
              estimatedMinutes: 123,
              suggestedSteps: ['step1', 'step2'],
              targetPath: 'path.md',
              acceptanceCriteria: [
                {
                  type: 'SECTION_PRESENT',
                  config: { heading: '事件循环' },
                  description: 'Contains a section comparing tasks and microtasks.',
                  required: true,
                },
                {
                  type: 'SEMANTIC_CORRECTNESS',
                  config: null,
                  description: 'Explains the ordering without reversing tasks and microtasks.',
                  required: true,
                },
              ],
              dependsOnTaskIds: [],
            },
          ],
        },
        {
          title: '测试标题1',
          tasks: [
            {
              id: 'a123',
              title: 'test-task-same-id',
              description: 'xxxxxxxxxxxx',
              type: 'MARKDOWN_NOTE',
              estimatedMinutes: 123,
              suggestedSteps: ['step1', 'step2'],
              targetPath: 'path.md',
              acceptanceCriteria: [
                {
                  type: 'SECTION_PRESENT',
                  config: { heading: '事件循环' },
                  description: 'Contains a section comparing tasks and microtasks.',
                  required: true,
                },
                {
                  type: 'SEMANTIC_CORRECTNESS',
                  config: null,
                  description: 'Explains the ordering without reversing tasks and microtasks.',
                  required: true,
                },
              ],
              dependsOnTaskIds: [],
            },
            {
              id: 'a124',
              title: 'test-task2',
              description: 'xxxxxxxxxxxx',
              type: 'MARKDOWN_NOTE',
              estimatedMinutes: 123,
              suggestedSteps: ['step1', 'step2'],
              targetPath: 'path.md',
              acceptanceCriteria: [
                {
                  type: 'SECTION_PRESENT',
                  config: { heading: '事件循环' },
                  description: 'Contains a section comparing tasks and microtasks.',
                  required: true,
                },
                {
                  type: 'SEMANTIC_CORRECTNESS',
                  config: null,
                  description: 'Explains the ordering without reversing tasks and microtasks.',
                  required: true,
                },
              ],
              dependsOnTaskIds: [],
            },
            {
              id: 'a125',
              title: 'test-task3',
              description: 'xxxxxxxxxxxx',
              type: 'MARKDOWN_NOTE',
              estimatedMinutes: 123,
              suggestedSteps: ['step1', 'step2'],
              targetPath: 'path.md',
              acceptanceCriteria: [
                {
                  type: 'SECTION_PRESENT',
                  config: { heading: '事件循环' },
                  description: 'Contains a section comparing tasks and microtasks.',
                  required: true,
                },
                {
                  type: 'SEMANTIC_CORRECTNESS',
                  config: null,
                  description: 'Explains the ordering without reversing tasks and microtasks.',
                  required: true,
                },
              ],
              dependsOnTaskIds: [],
            },
          ],
        },
      ],
    }

    const result = planGenerationOutputSchema.safeParse(plans)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'custom',
            path: ['stages', 1, 'tasks', 0, 'id'],
          }),
        ]),
      )
    }
  })

  it('rejects a dependency ID that does not exist in the generated plan', () => {
    const plans = {
      stages: [
        {
          title: '测试标题',
          tasks: [
            {
              id: 'a123',
              title: 'test-task',
              description: 'xxxxxxxxxxxx',
              type: 'MARKDOWN_NOTE',
              estimatedMinutes: 123,
              suggestedSteps: ['step1', 'step2'],
              targetPath: 'path.md',
              acceptanceCriteria: [
                {
                  type: 'SECTION_PRESENT',
                  config: { heading: '事件循环' },
                  description: 'Contains a section comparing tasks and microtasks.',
                  required: true,
                },
                {
                  type: 'SEMANTIC_CORRECTNESS',
                  config: null,
                  description: 'Explains the ordering without reversing tasks and microtasks.',
                  required: true,
                },
              ],
              dependsOnTaskIds: ['a234'], // id not exist
            },
            {
              id: 'a124',
              title: 'test-task2',
              description: 'xxxxxxxxxxxx',
              type: 'MARKDOWN_NOTE',
              estimatedMinutes: 123,
              suggestedSteps: ['step1', 'step2'],
              targetPath: 'path.md',
              acceptanceCriteria: [
                {
                  type: 'SECTION_PRESENT',
                  config: { heading: '事件循环' },
                  description: 'Contains a section comparing tasks and microtasks.',
                  required: true,
                },
                {
                  type: 'SEMANTIC_CORRECTNESS',
                  config: null,
                  description: 'Explains the ordering without reversing tasks and microtasks.',
                  required: true,
                },
              ],
              dependsOnTaskIds: [],
            },
            {
              id: 'a125',
              title: 'test-task3',
              description: 'xxxxxxxxxxxx',
              type: 'MARKDOWN_NOTE',
              estimatedMinutes: 123,
              suggestedSteps: ['step1', 'step2'],
              targetPath: 'path.md',
              acceptanceCriteria: [
                {
                  type: 'SECTION_PRESENT',
                  config: { heading: '事件循环' },
                  description: 'Contains a section comparing tasks and microtasks.',
                  required: true,
                },
                {
                  type: 'SEMANTIC_CORRECTNESS',
                  config: null,
                  description: 'Explains the ordering without reversing tasks and microtasks.',
                  required: true,
                },
              ],
              dependsOnTaskIds: [],
            },
          ],
        },
      ],
    }

    const result = planGenerationOutputSchema.safeParse(plans)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'custom',
            path: ['stages', 0, 'tasks', 0, 'dependsOnTaskIds', 0],
          }),
        ]),
      )
    }
  })

  it('rejects a task that depends on itself', () => {
    const plans = {
      stages: [
        {
          title: '测试标题',
          tasks: [
            {
              id: 'a123',
              title: 'test-task',
              description: 'xxxxxxxxxxxx',
              type: 'MARKDOWN_NOTE',
              estimatedMinutes: 123,
              suggestedSteps: ['step1', 'step2'],
              targetPath: 'path.md',
              acceptanceCriteria: [
                {
                  type: 'SECTION_PRESENT',
                  config: { heading: '事件循环' },
                  description: 'Contains a section comparing tasks and microtasks.',
                  required: true,
                },
                {
                  type: 'SEMANTIC_CORRECTNESS',
                  config: null,
                  description: 'Explains the ordering without reversing tasks and microtasks.',
                  required: true,
                },
              ],
              dependsOnTaskIds: ['a123'],
            },
            {
              id: 'a124',
              title: 'test-task2',
              description: 'xxxxxxxxxxxx',
              type: 'MARKDOWN_NOTE',
              estimatedMinutes: 123,
              suggestedSteps: ['step1', 'step2'],
              targetPath: 'path.md',
              acceptanceCriteria: [
                {
                  type: 'SECTION_PRESENT',
                  config: { heading: '事件循环' },
                  description: 'Contains a section comparing tasks and microtasks.',
                  required: true,
                },
                {
                  type: 'SEMANTIC_CORRECTNESS',
                  config: null,
                  description: 'Explains the ordering without reversing tasks and microtasks.',
                  required: true,
                },
              ],
              dependsOnTaskIds: [],
            },
            {
              id: 'a125',
              title: 'test-task3',
              description: 'xxxxxxxxxxxx',
              type: 'MARKDOWN_NOTE',
              estimatedMinutes: 123,
              suggestedSteps: ['step1', 'step2'],
              targetPath: 'path.md',
              acceptanceCriteria: [
                {
                  type: 'SECTION_PRESENT',
                  config: { heading: '事件循环' },
                  description: 'Contains a section comparing tasks and microtasks.',
                  required: true,
                },
                {
                  type: 'SEMANTIC_CORRECTNESS',
                  config: null,
                  description: 'Explains the ordering without reversing tasks and microtasks.',
                  required: true,
                },
              ],
              dependsOnTaskIds: [],
            },
          ],
        },
      ],
    }

    const result = planGenerationOutputSchema.safeParse(plans)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'custom',
            path: ['stages', 0, 'tasks', 0, 'dependsOnTaskIds', 0],
          }),
        ]),
      )
    }
  })

  it('accepts a dependency that points to a different task in another stage', () => {
    const plans = {
      stages: [
        {
          title: '测试标题',
          tasks: [
            {
              id: 'a123',
              title: 'test-task',
              description: 'xxxxxxxxxxxx',
              type: 'MARKDOWN_NOTE',
              estimatedMinutes: 123,
              suggestedSteps: ['step1', 'step2'],
              targetPath: 'path.md',
              acceptanceCriteria: [
                {
                  type: 'SECTION_PRESENT',
                  config: { heading: '事件循环' },
                  description: 'Contains a section comparing tasks and microtasks.',
                  required: true,
                },
                {
                  type: 'SEMANTIC_CORRECTNESS',
                  config: null,
                  description: 'Explains the ordering without reversing tasks and microtasks.',
                  required: true,
                },
              ],
              dependsOnTaskIds: ['a124', 'a125'],
            },
            {
              id: 'a124',
              title: 'test-task2',
              description: 'xxxxxxxxxxxx',
              type: 'MARKDOWN_NOTE',
              estimatedMinutes: 123,
              suggestedSteps: ['step1', 'step2'],
              targetPath: 'path.md',
              acceptanceCriteria: [
                {
                  type: 'SECTION_PRESENT',
                  config: { heading: '事件循环' },
                  description: 'Contains a section comparing tasks and microtasks.',
                  required: true,
                },
                {
                  type: 'SEMANTIC_CORRECTNESS',
                  config: null,
                  description: 'Explains the ordering without reversing tasks and microtasks.',
                  required: true,
                },
              ],
              dependsOnTaskIds: [],
            },
          ],
        },
        {
          title: 'cross-stage-test',
          tasks: [
            {
              id: 'a125',
              title: 'cross-stage-test-task',
              description: 'xxxxxxxxxxxxx',
              type: 'MARKDOWN_NOTE',
              estimatedMinutes: 123,
              suggestedSteps: ['step1', 'step2'],
              targetPath: 'path.md',
              acceptanceCriteria: [
                {
                  type: 'SECTION_PRESENT',
                  config: { heading: '事件循环' },
                  description: 'Contains a section comparing tasks and microtasks.',
                  required: true,
                },
                {
                  type: 'SEMANTIC_CORRECTNESS',
                  config: null,
                  description: 'Explains the ordering without reversing tasks and microtasks.',
                  required: true,
                },
              ],
              dependsOnTaskIds: [],
            },
          ],
        },
      ],
    }

    const result = planGenerationOutputSchema.safeParse(plans)
    expect(result.success).toBe(true)
  })

  it('Task A depends on B and Task B depends on A', () => {
    const plans = {
      stages: [
        {
          title: '测试标题',
          tasks: [
            {
              id: 'a123',
              title: 'test-task',
              description: 'xxxxxxxxxxxx',
              type: 'MARKDOWN_NOTE',
              estimatedMinutes: 123,
              suggestedSteps: ['step1', 'step2'],
              targetPath: 'path.md',
              acceptanceCriteria: [
                {
                  type: 'SECTION_PRESENT',
                  config: { heading: '事件循环' },
                  description: 'Contains a section comparing tasks and microtasks.',
                  required: true,
                },
                {
                  type: 'SEMANTIC_CORRECTNESS',
                  config: null,
                  description: 'Explains the ordering without reversing tasks and microtasks.',
                  required: true,
                },
              ],
              dependsOnTaskIds: ['a124'],
            },
            {
              id: 'a124',
              title: 'test-task2',
              description: 'xxxxxxxxxxxx',
              type: 'MARKDOWN_NOTE',
              estimatedMinutes: 123,
              suggestedSteps: ['step1', 'step2'],
              targetPath: 'path.md',
              acceptanceCriteria: [
                {
                  type: 'SECTION_PRESENT',
                  config: { heading: '事件循环' },
                  description: 'Contains a section comparing tasks and microtasks.',
                  required: true,
                },
                {
                  type: 'SEMANTIC_CORRECTNESS',
                  config: null,
                  description: 'Explains the ordering without reversing tasks and microtasks.',
                  required: true,
                },
              ],
              dependsOnTaskIds: ['a123'],
            },
            {
              id: 'a125',
              title: 'test-task3',
              description: 'xxxxxxxxxxxx',
              type: 'MARKDOWN_NOTE',
              estimatedMinutes: 123,
              suggestedSteps: ['step1', 'step2'],
              targetPath: 'path.md',
              acceptanceCriteria: [
                {
                  type: 'SECTION_PRESENT',
                  config: { heading: '事件循环' },
                  description: 'Contains a section comparing tasks and microtasks.',
                  required: true,
                },
                {
                  type: 'SEMANTIC_CORRECTNESS',
                  config: null,
                  description: 'Explains the ordering without reversing tasks and microtasks.',
                  required: true,
                },
              ],
              dependsOnTaskIds: [],
            },
          ],
        },
      ],
    }

    const result = planGenerationOutputSchema.safeParse(plans)
    // console.log(result.error)
    expect(result.success).toBe(true)
  })
})
