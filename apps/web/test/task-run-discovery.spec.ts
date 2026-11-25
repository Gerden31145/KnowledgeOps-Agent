import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref, type EffectScope } from 'vue'
import { focusManager, onlineManager, QueryClient } from '@tanstack/vue-query'
import {
  toPublicExerciseSet,
  type PlanDetailResponse,
  type TaskDetailResponse,
  type TaskSummaryResponse,
} from '@knowledgeops/contracts'
import { validCourseLearningPackage } from '../../../packages/agent-core/test/fixtures/course-generation.js'
import { useTaskQuery } from '../app/composables/use-course-query'
import { usePlanQuery } from '../app/composables/use-workspace-queries'
import { TASK_DISCOVERY_POLL_MS } from '../app/lib/verification-polling'
import { taskDetail, taskId, runId, otherRunId } from './fixtures/note-verification'

const ports = vi.hoisted(() => {
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  return {
    read: vi.fn(),
    summaryRead: vi.fn(),
    planRead: vi.fn(),
    client: undefined as unknown as QueryClient,
  }
})
vi.mock('../app/composables/use-course-api', () => ({
  useCourseApi: () => ({
    getTask: ports.read,
    getTaskSummary: ports.summaryRead,
  }),
}))
vi.mock('../app/composables/use-plan-api', () => ({
  usePlanApi: () => ({ getPlan: ports.planRead }),
}))
vi.mock('@tanstack/vue-query', async (original) => {
  const library = await original<typeof import('@tanstack/vue-query')>()
  return {
    ...library,
    useQueryClient: () => ports.client,
    useQuery: (options: Parameters<typeof library.useQuery>[0]) =>
      library.useQuery(options, ports.client),
  }
})

function courseTask(
  status: NonNullable<TaskDetailResponse['course']>['status'] = 'READY',
  generationRunId = runId,
  withContent = true,
): TaskDetailResponse {
  return taskDetail({
    type: 'COURSE',
    targetPath: null,
    course: {
      status,
      generationRunId,
      generationQueuedAt: '2026-10-30T00:00:00.000Z',
      error: null,
      sections: withContent ? validCourseLearningPackage.sections : null,
      exercises: withContent ? toPublicExerciseSet(validCourseLearningPackage.exercises) : null,
    },
  })
}

function summaryFor(task: TaskDetailResponse): TaskSummaryResponse {
  const { course, ...summary } = task
  return {
    ...summary,
    course: course
      ? {
          status: course.status,
          generationRunId: course.generationRunId,
          generationQueuedAt: course.generationQueuedAt,
          error: course.error,
        }
      : null,
  }
}

const activePlan: PlanDetailResponse = {
  id: taskId,
  version: 1,
  status: 'ACTIVE',
  confirmedAt: '2026-10-30T00:00:00.000Z',
  goal: {
    id: taskId,
    title: '性能学习',
    deadline: '2026-12-31',
    weeklyMinutes: 600,
  },
  stages: [],
}

let scope: EffectScope
const mount = () => scope.run(() => useTaskQuery(taskId))!
async function tick(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms)
  await nextTick()
}

describe('course and plan discovery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    ports.read.mockReset().mockResolvedValue(courseTask())
    ports.summaryRead.mockReset()
    ports.planRead.mockReset().mockResolvedValue(activePlan)
    ports.client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    ports.client.mount()
    focusManager.setFocused(true)
    onlineManager.setOnline(true)
    scope = effectScope()
  })
  afterEach(() => {
    scope.stop()
    ports.client.unmount()
    ports.client.clear()
    focusManager.setFocused(undefined)
    onlineManager.setOnline(true)
    vi.useRealTimers()
  })

  it('does not poll a stable course and reuses immutable content on a summary refresh', async () => {
    const initial = courseTask()
    ports.read.mockResolvedValue(initial)
    ports.summaryRead.mockImplementation(async () => summaryFor(courseTask()))
    const query = mount()
    await tick()
    await tick(TASK_DISCOVERY_POLL_MS * 3)
    expect(ports.read).toHaveBeenCalledTimes(1)
    expect(ports.summaryRead).not.toHaveBeenCalled()

    await query.refetch()
    expect(ports.summaryRead).toHaveBeenCalledTimes(1)
    expect(ports.read).toHaveBeenCalledTimes(1)
    expect(query.data.value?.course?.sections).toEqual(initial.course?.sections)
    expect(query.data.value?.course?.exercises).toEqual(initial.course?.exercises)
  })

  it('polls only a generating course summary and reloads content when it becomes ready', async () => {
    ports.read
      .mockResolvedValueOnce(courseTask('GENERATING', runId, false))
      .mockResolvedValue(courseTask('READY', runId, true))
    ports.summaryRead.mockResolvedValue(summaryFor(courseTask('READY', runId, false)))
    const query = mount()
    await tick()
    expect(ports.read).toHaveBeenCalledTimes(1)

    await tick(TASK_DISCOVERY_POLL_MS)
    expect(ports.summaryRead).toHaveBeenCalledTimes(1)
    expect(ports.read).toHaveBeenCalledTimes(2)
    expect(query.data.value?.course?.status).toBe('READY')
    expect(query.data.value?.course?.sections).toHaveLength(3)
    await tick(TASK_DISCOVERY_POLL_MS * 2)
    expect(ports.summaryRead).toHaveBeenCalledTimes(1)
  })

  it('reloads full content when a summary discovers a new generation Run', async () => {
    ports.read
      .mockResolvedValueOnce(courseTask('FAILED', runId, false))
      .mockResolvedValue(courseTask('READY', otherRunId, true))
    ports.summaryRead.mockResolvedValue(summaryFor(courseTask('READY', otherRunId, false)))
    const query = mount()
    await tick()
    await query.refetch()
    expect(ports.summaryRead).toHaveBeenCalledTimes(1)
    expect(ports.read).toHaveBeenCalledTimes(2)
    expect(query.data.value?.course?.generationRunId).toBe(otherRunId)
    expect(query.data.value?.course?.exercises).not.toBeNull()
  })

  it.each(['BLOCKED', 'READY', 'PASSED'] as const)('does not poll a %s Task', async (state) => {
    ports.read.mockResolvedValue(taskDetail({ type: 'COURSE', state }))
    mount()
    await tick(TASK_DISCOVERY_POLL_MS * 3)
    expect(ports.read).toHaveBeenCalledTimes(1)
  })

  it('ignores older Task versions and terminal state regression', async () => {
    const current = courseTask()
    current.version = 3
    current.state = 'PASSED'
    ports.read.mockResolvedValue(current)
    const query = mount()
    await tick()
    const older = courseTask()
    older.version = 2
    ports.summaryRead.mockResolvedValue(summaryFor(older))
    await query.refetch()
    expect(query.data.value?.version).toBe(3)
    expect(query.data.value?.state).toBe('PASSED')
  })

  it('rejects a snapshot belonging to a different Task', async () => {
    ports.read.mockResolvedValue(courseTask())
    ports.read.mockResolvedValueOnce(taskDetail({ id: otherRunId, type: 'COURSE' }))
    const query = mount()
    await tick(TASK_DISCOVERY_POLL_MS * 2)
    expect(query.isError.value).toBe(true)
    expect(query.data.value).toBeUndefined()
    expect(ports.read).toHaveBeenCalledTimes(1)
  })

  it('cancels an old Task read on navigation and releases timers on leaving', async () => {
    let finish!: (value: TaskDetailResponse) => void
    ports.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const id = ref(taskId)
    const query = scope.run(() => useTaskQuery(id))!
    await tick()
    const oldSignal = ports.read.mock.calls[0]![1] as AbortSignal
    const otherCourse = courseTask()
    otherCourse.id = otherRunId
    ports.read.mockResolvedValue(otherCourse)
    id.value = otherRunId
    await tick()
    expect(oldSignal.aborted).toBe(true)
    finish(courseTask())
    await tick()
    expect(query.data.value?.id).toBe(otherRunId)
    scope.stop()
    expect(query.data.value?.course?.status).toBe('READY')
  })

  it('stops plan polling but refreshes on explicit invalidation, reconnect and focus', async () => {
    const query = scope.run(() => usePlanQuery(taskId))!
    await tick()
    await tick(30_000)
    expect(ports.planRead).toHaveBeenCalledTimes(1)
    await query.refetch()
    expect(ports.planRead).toHaveBeenCalledTimes(2)
    onlineManager.setOnline(false)
    onlineManager.setOnline(true)
    await tick()
    expect(ports.planRead).toHaveBeenCalledTimes(3)
    focusManager.setFocused(false)
    focusManager.setFocused(true)
    await tick()
    expect(ports.planRead).toHaveBeenCalledTimes(4)
  })

  it('polls a plan only while a course is generating', async () => {
    const generatingPlan: PlanDetailResponse = {
      ...activePlan,
      stages: [
        {
          id: taskId,
          title: '课程',
          position: 0,
          tasks: [
            {
              id: taskId,
              title: '生成中的课程',
              description: '等待课程内容。',
              position: 0,
              type: 'COURSE',
              estimatedMinutes: 30,
              suggestedSteps: [],
              targetPath: null,
              state: 'READY',
              version: 0,
              prerequisiteTaskIds: [],
              criteria: [],
              course: {
                status: 'GENERATING',
                generationRunId: runId,
                generationQueuedAt: '2026-10-30T00:00:00.000Z',
                error: null,
              },
            },
          ],
        },
      ],
    }
    ports.planRead.mockResolvedValue(generatingPlan)
    const query = scope.run(() => usePlanQuery(taskId))!
    await tick()
    expect(query.data.value?.stages[0]?.tasks[0]?.course?.status).toBe('GENERATING')
    await tick(TASK_DISCOVERY_POLL_MS + 1)
    expect(ports.planRead).toHaveBeenCalledTimes(2)
    ports.planRead.mockResolvedValue(activePlan)
    await tick(TASK_DISCOVERY_POLL_MS)
    expect(ports.planRead).toHaveBeenCalledTimes(3)
    await tick(TASK_DISCOVERY_POLL_MS * 2)
    expect(ports.planRead).toHaveBeenCalledTimes(3)
  })
})
