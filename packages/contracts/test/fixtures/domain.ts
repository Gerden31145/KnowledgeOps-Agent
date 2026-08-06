import type { AgentRunDto, TaskDto } from '../../src/index.js'

const DEFAULT_TASK = {
  id: '10c4e6cc-0041-4f53-8f68-2c5ea1f93e37',
  stageId: 'da81199f-6d47-4524-b8f4-4d3217d9a80d',
  title: '梳理事件循环',
  state: 'IN_PROGRESS',
  position: 1,
  targetPath: 'notes/event-loop.md',
  version: 2,
  createdAt: '2026-08-03T01:00:00.000Z',
  updatedAt: '2026-08-03T02:00:00.000Z',
} as const satisfies TaskDto

const DEFAULT_AGENT_RUN = {
  id: '79f9028f-2f99-4fcb-98ff-6d45e70175c3',
  taskId: DEFAULT_TASK.id,
  kind: 'NOTE_VERIFICATION',
  status: 'QUEUED',
  taskStateBeforeRun: 'IN_PROGRESS',
  retryOfRunId: null,
  workflowVersion: 'note-v1',
  version: 0,
  queuedAt: '2026-08-03T01:00:00.000Z',
  startedAt: null,
  finishedAt: null,
} as const satisfies AgentRunDto

/** Returns a fresh, schema-valid baseline while keeping each test focused on its override. */
export function createTaskDtoFixture(overrides: Partial<TaskDto> = {}): TaskDto {
  return { ...DEFAULT_TASK, ...overrides }
}

/** Overrides may intentionally create an invalid cross-field combination for negative tests. */
export function createAgentRunDtoFixture(overrides: Partial<AgentRunDto> = {}): AgentRunDto {
  return { ...DEFAULT_AGENT_RUN, ...overrides }
}
