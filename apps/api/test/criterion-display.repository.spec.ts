import { randomUUID } from 'node:crypto'
import type { DatabaseClient } from '@knowledgeops/database'
import { describe, expect, it, vi } from 'vitest'
import { PlanRepository } from '../src/plans/plan.repository.js'

describe('workspace criterion parameters', () => {
  it.each([
    { type: 'SECTION_PRESENT', config: { heading: '事件循环' }, expected: '标题“事件循环”' },
    { type: 'CONTENT_MINIMUM', config: { minCharacters: 500 }, expected: '至少 500 个非空白字符' },
    { type: 'SECTION_PRESENT', config: null, expected: '暂时无法自动判定' },
    { type: 'SECTION_PRESENT', config: { heading: '' }, expected: '暂时无法自动判定' },
    { type: 'SECTION_PRESENT', config: { minCharacters: 100 }, expected: '暂时无法自动判定' },
    { type: 'CONTENT_MINIMUM', config: null, expected: '暂时无法自动判定' },
    { type: 'CONTENT_MINIMUM', config: { minCharacters: -1 }, expected: '暂时无法自动判定' },
    { type: 'CONTENT_MINIMUM', config: { heading: '概念' }, expected: '暂时无法自动判定' },
    { type: 'SEMANTIC_CORRECTNESS', config: null, expected: null },
  ])('reads $type / $config consistently in both views', async ({ type, config, expected }) => {
    const userId = randomUUID()
    const planId = randomUUID()
    const stageId = randomUUID()
    const criterion = {
      id: randomUUID(),
      type,
      config,
      // Deliberately disagree with executable config: descriptions must not determine thresholds.
      description: '请包含“错误标题”，并写满 9999 字。',
      required: true,
      position: 0,
    }
    const task = {
      id: randomUUID(),
      title: '事件循环',
      description: '写学习笔记',
      position: 0,
      type: 'MARKDOWN_NOTE',
      estimatedMinutes: 30,
      suggestedSteps: ['阅读并记录'],
      targetPath: 'notes/event-loop.md',
      state: 'READY',
      version: 1,
      prerequisites: [],
      criteria: [criterion],
    }
    const findPlan = vi.fn().mockResolvedValue({
      id: planId,
      version: 1,
      status: 'ACTIVE',
      confirmedAt: new Date(),
      goal: {
        id: randomUUID(),
        title: '学习 JavaScript',
        deadline: new Date(),
        weeklyMinutes: 300,
      },
      stages: [{ id: stageId, title: '基础', position: 0, tasks: [task] }],
    })
    const findTask = vi.fn().mockResolvedValue({
      ...task,
      runs: [],
      stage: { id: stageId, title: '基础', position: 0, plan: { id: planId, status: 'ACTIVE' } },
    })
    const repository = new PlanRepository({
      plan: { findFirst: findPlan },
      task: { findFirst: findTask },
    } as unknown as DatabaseClient)

    const plan = await repository.findDetailByIdForUser(planId, userId)
    const detail = await repository.findTaskDetailForUser(task.id, userId)
    const fromPlan = plan?.stages[0]?.tasks[0]?.criteria[0]
    const fromTask = detail?.criteria[0]
    expect(fromPlan).toEqual(fromTask)
    expect(fromTask?.description).toBe(criterion.description)
    expect(fromTask).not.toHaveProperty('config')
    if (expected === null) expect(fromTask?.parameterDescription).toBeNull()
    else {
      expect(fromTask?.parameterDescription).toContain(expected)
      expect(fromTask?.parameterDescription).not.toContain('9999')
      expect(fromTask?.parameterDescription).not.toContain('错误标题')
    }
    expect(findPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: planId, goal: { userId } },
        select: expect.objectContaining({
          stages: expect.objectContaining({
            select: expect.objectContaining({
              tasks: expect.objectContaining({
                select: expect.objectContaining({
                  criteria: expect.objectContaining({
                    select: expect.objectContaining({ config: true }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    )
    expect(findTask).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: task.id, stage: { plan: { goal: { userId } } } },
        select: expect.objectContaining({
          criteria: expect.objectContaining({
            select: expect.objectContaining({ config: true }),
          }),
        }),
      }),
    )
  })
})
