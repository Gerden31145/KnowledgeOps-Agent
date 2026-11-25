import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import type { TaskDetailResponse } from '@knowledgeops/contracts'
import type { CourseApi } from '../lib/course-api'
import { knowledgeOpsQueryKeys } from '../lib/query-keys'
import { taskDiscoveryPollInterval } from '../lib/verification-polling'
import { useCourseApi } from './use-course-api'

export function useTaskQuery(taskId: MaybeRefOrGetter<string | null>) {
  const api = useCourseApi()
  const client = useQueryClient()

  return useQuery({
    queryKey: computed(() => knowledgeOpsQueryKeys.task(toValue(taskId) ?? 'disabled')),
    queryFn: async ({ signal }) => {
      const id = toValue(taskId)
      if (!id) throw new Error('taskId is required while the task query is enabled')
      const previous = client.getQueryData<TaskDetailResponse>(knowledgeOpsQueryKeys.task(id))
      const snapshot = await readTaskSnapshot(api, id, previous, signal)
      if (snapshot.id !== id) throw new Error('任务快照与当前任务不匹配。')
      // 同版本的运行列表可以更新，但迟到的 Task 版本不能覆盖新状态。
      if (
        previous &&
        (snapshot.version < previous.version ||
          (snapshot.version === previous.version && snapshot.state !== previous.state) ||
          (previous.state === 'PASSED' && snapshot.state !== 'PASSED'))
      )
        return previous
      return snapshot
    },
    enabled: computed(() => Boolean(toValue(taskId))),
    staleTime: 0,
    retry: false,
    refetchInterval: (current) =>
      taskDiscoveryPollInterval(current.state.data, current.state.error),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  })
}

async function readTaskSnapshot(
  api: CourseApi,
  taskId: string,
  previous: TaskDetailResponse | undefined,
  signal: AbortSignal,
): Promise<TaskDetailResponse> {
  if (previous?.type !== 'COURSE') return api.getTask(taskId, signal)
  const summary = await api.getTaskSummary(taskId, signal)
  if (summary.id !== taskId) throw new Error('任务摘要与当前任务不匹配。')
  const currentCourse = summary.course
  const previousCourse = previous.course
  if (!currentCourse && !previousCourse) return { ...summary, course: null }
  if (
    currentCourse &&
    previousCourse &&
    currentCourse.generationRunId === previousCourse.generationRunId &&
    (currentCourse.status !== 'READY' ||
      (previousCourse.status === 'READY' &&
        previousCourse.sections !== null &&
        previousCourse.exercises !== null))
  ) {
    return {
      ...summary,
      course: {
        ...currentCourse,
        sections: previousCourse.sections,
        exercises: previousCourse.exercises,
      },
    }
  }
  return api.getTask(taskId, signal)
}
