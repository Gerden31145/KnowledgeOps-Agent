import type { PlanGenerationOutput, PlanGenerationRequest } from '../../src/index.js'

export const validPlanGenerationRequest = {
  generationRunId: '7fb289a2-0376-43f2-bbb2-ff339257f673',
  model: {
    catalogId: 'openai-primary',
    provider: 'openai',
    modelName: 'test-model',
    promptVersion: 'plan-generation-v1',
    outputSchemaVersion: 'plan-generation-output-v1',
  },
  goal: {
    title: 'Prepare for frontend internship interviews',
    currentLevel: 'Comfortable with Vue 3 and TypeScript, new to backend architecture.',
    today: '2026-08-10',
    deadline: '2026-09-10',
    weeklyMinutes: 600,
  },
} as const satisfies PlanGenerationRequest

export const validPlanGenerationOutput = {
  stages: [
    {
      title: 'JavaScript foundations',
      tasks: [
        {
          id: 'event-loop',
          title: 'Explain the event loop',
          description: 'Write a note explaining tasks, microtasks, and rendering order.',
          type: 'MARKDOWN_NOTE',
          estimatedMinutes: 90,
          suggestedSteps: ['Draw one execution timeline', 'Explain one browser rendering example'],
          targetPath: 'notes/javascript/event-loop.md',
          acceptanceCriteria: [
            {
              type: 'SECTION_PRESENT',
              description: 'Contains a section comparing tasks and microtasks.',
              required: true,
            },
            {
              type: 'SEMANTIC_CORRECTNESS',
              description: 'Explains the ordering without reversing tasks and microtasks.',
              required: true,
            },
          ],
          dependsOnTaskIds: [],
        },
        {
          id: 'browser-rendering',
          title: 'Connect scheduling to rendering',
          description: 'Write a note connecting JavaScript scheduling to browser rendering.',
          type: 'MARKDOWN_NOTE',
          estimatedMinutes: 75,
          suggestedSteps: ['Describe style and layout work', 'Add one frame lifecycle example'],
          targetPath: 'notes/browser/rendering.md',
          acceptanceCriteria: [
            {
              type: 'TOPIC_COVERAGE',
              description: 'Covers style, layout, paint, and composite.',
              required: true,
            },
          ],
          dependsOnTaskIds: ['event-loop'],
        },
        {
          id: 'vue-scheduling',
          title: 'Explain Vue update scheduling',
          description: 'Write a note relating Vue updates to the browser scheduling model.',
          type: 'MARKDOWN_NOTE',
          estimatedMinutes: 75,
          suggestedSteps: ['Explain nextTick', 'Compare one synchronous and batched update'],
          targetPath: 'notes/vue/update-scheduling.md',
          acceptanceCriteria: [
            {
              type: 'EXPLANATION_QUALITY',
              description: 'Uses a concrete example to explain batched updates.',
              required: true,
            },
          ],
          dependsOnTaskIds: ['event-loop', 'browser-rendering'],
        },
      ],
    },
  ],
} as const satisfies PlanGenerationOutput
