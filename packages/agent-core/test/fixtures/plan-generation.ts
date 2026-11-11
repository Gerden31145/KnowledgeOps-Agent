import type { PlanGenerationOutput, PlanGenerationRequest } from '../../src/index.js'

export const validPlanGenerationRequest = {
  generationRunId: '7fb289a2-0376-43f2-bbb2-ff339257f673',
  model: {
    catalogId: 'openai-primary',
    provider: 'openai',
    modelName: 'test-model',
    promptVersion: 'plan-generation-v3',
    outputSchemaVersion: 'plan-generation-output-v3',
  },
  goal: {
    title: 'Prepare for frontend internship interviews',
    currentLevel: 'Comfortable with Vue 3 and TypeScript, new to backend architecture.',
    today: '2026-08-10',
    deadline: '2026-09-10',
    weeklyMinutes: 600,
  },
} as const satisfies PlanGenerationRequest

const eventLoopPoint = {
  id: 'event-loop',
  title: '事件循环',
  description: '理解任务、微任务与渲染之间的调度顺序。',
} as const

export const validPlanGenerationOutput = {
  stages: [
    {
      title: 'JavaScript foundations',
      tasks: [
        {
          id: 'event-loop',
          title: 'Explain the event loop',
          description: 'Learn tasks, microtasks, and rendering order through browser scenarios.',
          type: 'COURSE',
          estimatedMinutes: 90,
          knowledgePoints: [eventLoopPoint],
          dependsOnTaskIds: [],
        },
        {
          id: 'browser-rendering',
          title: 'Connect scheduling to rendering',
          description: 'Connect JavaScript scheduling to browser rendering in one frame.',
          type: 'COURSE',
          estimatedMinutes: 75,
          knowledgePoints: [
            eventLoopPoint,
            {
              id: 'rendering-pipeline',
              title: '渲染流水线',
              description: '理解样式、布局、绘制与合成的关系。',
            },
          ],
          dependsOnTaskIds: ['event-loop'],
        },
        {
          id: 'vue-scheduling',
          title: 'Explain Vue update scheduling',
          description: 'Relate Vue batched updates to the browser scheduling model.',
          type: 'COURSE',
          estimatedMinutes: 75,
          knowledgePoints: [
            eventLoopPoint,
            {
              id: 'vue-next-tick',
              title: 'Vue 批量更新',
              description: '理解批量更新与 nextTick 的执行时机。',
            },
          ],
          dependsOnTaskIds: ['event-loop', 'browser-rendering'],
        },
      ],
    },
  ],
} as const satisfies PlanGenerationOutput
