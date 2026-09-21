import { KnowledgeOpsApiError } from './knowledge-ops-api'
import type { PlanStreamHandlers, PlanStreamIssue } from './plan-generation-stream'
import {
  initialRecoveryState,
  reducePlanRunRecovery,
  type RecoveryEvent,
  type RecoveryIssue,
  type RecoveryState,
  type RunSnapshot,
} from './plan-run-recovery.exercise'

export const RECOVERY_FALLBACK_MS = 10_000
export const RECOVERY_POLL_MS = 2000
export interface RecoveryPorts {
  read(runId: string, signal: AbortSignal): Promise<RunSnapshot>
  subscribe(runId: string, handlers: PlanStreamHandlers): { close(): void }
  cache(runId: string, snapshot: RunSnapshot | undefined): void
  changed(state: RecoveryState): void
}

// 只执行状态所要求的资源操作；没有版本比较、终态判断或旧批次过滤的等价答案。
export function createPlanRunRecovery(ports: RecoveryPorts, reduce = reducePlanRunRecovery) {
  let state = initialRecoveryState()
  let disposed = false
  let stream: { close(): void } | undefined
  let flight: AbortController | undefined
  let queuedRead = false
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  const active = () => state.mode !== 'idle' && state.mode !== 'stopped' && state.runId !== null
  const closeStream = () => {
    stream?.close()
    stream = undefined
  }
  const clearResources = () => {
    closeStream()
    clearTimeout(fallbackTimer)
    fallbackTimer = undefined
    clearTimeout(pollTimer)
    pollTimer = undefined
    flight?.abort()
    flight = undefined
    queuedRead = false
  }
  const schedulePoll = () => {
    clearTimeout(pollTimer)
    if (state.mode === 'polling' && !disposed) {
      pollTimer = setTimeout(() => {
        pollTimer = undefined
        pull()
      }, RECOVERY_POLL_MS)
    }
  }
  const pull = () => {
    if (!active() || disposed) return
    clearTimeout(pollTimer)
    pollTimer = undefined
    if (flight) {
      queuedRead = true
      return
    }
    const request = new AbortController()
    flight = request
    const { runId, epoch } = state
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)])
    void ports
      .read(runId!, signal)
      .then(
        (snapshot) => send({ type: 'snapshot', epoch, snapshot }),
        (error: unknown) => {
          // 主动撤销不制造网络错误；不合作端口的迟到成功仍交给用户函数判断 epoch。
          if (!request.signal.aborted) send({ type: 'issue', epoch, issue: httpIssue(error) })
        },
      )
      .finally(() => {
        if (flight !== request) return
        flight = undefined
        if (queuedRead) {
          queuedRead = false
          pull()
        } else schedulePoll()
      })
  }
  function send(event: RecoveryEvent) {
    if (disposed) return
    const previous = state
    state = reduce(state, event)
    if (state.epoch !== previous.epoch || !active()) clearResources()
    if (state.runId && state.snapshot !== previous.snapshot)
      ports.cache(state.runId, state.snapshot)
    if (active()) {
      const epoch = state.epoch
      if (state.mode === 'connecting' || state.mode === 'streaming') {
        if (!stream) {
          try {
            stream = ports.subscribe(state.runId!, {
              onOpen: () => send({ type: 'opened', epoch }),
              onSnapshot: (snapshot) => send({ type: 'snapshot', epoch, snapshot }),
              onIssue: (issue) => send({ type: 'issue', epoch, issue: streamIssue(issue) }),
            })
          } catch {
            send({ type: 'issue', epoch, issue: streamIssue({ kind: 'protocol' }) })
          }
        }
      } else closeStream()
      if (state.mode === 'connecting') {
        // 同一轮反复 error 不延后截止时间，防止始终无法降级。
        fallbackTimer ??= setTimeout(() => {
          fallbackTimer = undefined
          send({ type: 'fallback-due', epoch })
        }, RECOVERY_FALLBACK_MS)
      } else {
        clearTimeout(fallbackTimer)
        fallbackTimer = undefined
      }
      if (state.mode !== 'polling') {
        clearTimeout(pollTimer)
        pollTimer = undefined
      }
      if (
        state.refreshKey !== previous.refreshKey ||
        (state.mode === 'polling' && previous.mode !== 'polling')
      )
        pull()
    }
    ports.changed(state)
  }
  return {
    get state() {
      return state
    },
    select(runId: string | null, cached?: RunSnapshot) {
      send({ type: 'select', runId, ...(cached ? { cached } : {}) })
    },
    refresh() {
      send({ type: 'refresh' })
    },
    dispose() {
      send({ type: 'stop' })
      disposed = true
      clearResources()
    },
  }
}

function httpIssue(error: unknown): RecoveryIssue {
  if (error instanceof KnowledgeOpsApiError) {
    if (error.status === 401 || error.status === 403)
      return { kind: 'unauthorized', message: '登录已失效，请重新登录。' }
    if (error.status === 400 || error.status === 404)
      return { kind: 'not-found', message: '运行 ID 无效、不存在或无权访问。' }
  }
  return { kind: 'unavailable', message: '暂时无法同步状态，正在通过 HTTP 重试。' }
}
function streamIssue(issue: PlanStreamIssue): RecoveryIssue {
  if (issue.kind === 'connection')
    return { kind: 'connection', message: '实时连接暂时中断，正在重连。' }
  if (issue.kind === 'server' && issue.code === 'UNAUTHENTICATED')
    return { kind: 'unauthorized', message: '登录已失效，请重新登录。' }
  if (issue.kind === 'server' && issue.code === 'RESOURCE_NOT_FOUND')
    return { kind: 'not-found', message: '运行不存在或无权访问。' }
  return { kind: 'unavailable', message: '实时订阅不可用，正在使用 HTTP 同步。' }
}
