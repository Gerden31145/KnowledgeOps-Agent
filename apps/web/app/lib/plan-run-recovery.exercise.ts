import type { PlanGenerationRunStatusResponse } from '@knowledgeops/contracts'

export type RunSnapshot = PlanGenerationRunStatusResponse
export type RecoveryMode = 'idle' | 'connecting' | 'streaming' | 'polling' | 'stopped'
export interface RecoveryIssue {
  kind: 'connection' | 'unavailable' | 'unauthorized' | 'not-found'
  message: string
}
export interface RecoveryState {
  runId: string | null
  /** 本地订阅批次，与数据库 Run.version 无关。切换/停止后，旧批次结果必须失效。 */
  epoch: number
  snapshot: RunSnapshot | undefined
  mode: RecoveryMode
  issue: RecoveryIssue | null
  /** 增加此数表示需要一次 HTTP 校准；请求执行与并发合并由适配器负责。 */
  refreshKey: number
}
export type RecoveryEvent =
  | { type: 'select'; runId: string | null; cached?: RunSnapshot }
  | { type: 'stop' }
  | { type: 'refresh' }
  | { type: 'opened'; epoch: number }
  | { type: 'snapshot'; epoch: number; snapshot: RunSnapshot }
  | { type: 'issue'; epoch: number; issue: RecoveryIssue }
  | { type: 'fallback-due'; epoch: number }

export function initialRecoveryState(): RecoveryState {
  return { runId: null, epoch: 0, snapshot: undefined, mode: 'idle', issue: null, refreshKey: 0 }
}

/** C2 唯一手写入口。纯函数：不要在这里调用 fetch、EventSource、计时器或 QueryClient。 */
export function reducePlanRunRecovery(state: RecoveryState, event: RecoveryEvent): RecoveryState {
  // TODO(user): 根据手写说明实现：生命周期隔离、快照归并、重连校准、兜底与停止决策。
  // 保留快照引用意味着“不重复写缓存”；不要修改传入的 state / event。

  if (event.type === 'stop' || (event.type === 'select' && event.runId === null))
    return {
      ...state,
      mode: 'idle',
      epoch: state.epoch + 1,
      runId: null,
      snapshot: undefined,
      issue: null,
    }

  if (event.type === 'select')
    return {
      ...state,
      epoch: state.epoch + 1,
      runId: event.runId,
      snapshot:
        event.cached && event.cached.generationRunId === event.runId ? event.cached : undefined,
      mode: 'connecting',
      issue: null,
      refreshKey: state.refreshKey + 1,
    }

  if (state.mode === 'idle')
    return {
      ...state,
    }

  // 终态已确定，不可更改
  if (state.mode === 'stopped')
    return {
      ...state,
    }

  // 非法状态
  if ('epoch' in event && event.epoch !== state.epoch) {
    return {
      ...state,
    }
  }

  // 刷新
  if (
    event.type === 'refresh' &&
    (state.mode === 'connecting' || state.mode === 'streaming' || state.mode === 'polling')
  ) {
    return {
      ...state,
      refreshKey: state.refreshKey + 1,
    }
  }

  // 首次进入或者断线后重连或者刷新
  if ((state.mode === 'connecting' || state.mode === 'streaming') && event.type === 'opened')
    return {
      ...state,
      refreshKey: state.refreshKey + 1,
      issue: null,
      mode: 'streaming',
    }
  if (state.mode === 'connecting' && event.type === 'fallback-due')
    return {
      ...state,
      mode: 'polling',
    }

  // 错误情况
  if (event.type === 'issue') {
    if (event.issue.kind === 'unavailable')
      return {
        ...state,
        mode: 'polling',
        issue: event.issue,
      }
    if (event.issue.kind === 'unauthorized' || event.issue.kind === 'not-found')
      return {
        ...state,
        issue: event.issue,
        snapshot: undefined,
        mode: 'stopped',
      }
    if (
      event.issue.kind === 'connection' &&
      (state.mode === 'connecting' || state.mode === 'streaming')
    )
      return {
        ...state,
        mode: 'connecting',
        refreshKey: state.refreshKey + 1,
        issue: event.issue,
      }
  }

  // 收到快照
  if (event.type === 'snapshot' && event.snapshot.generationRunId === state.runId) {
    // 终态已确定，不可更改
    if (
      state.snapshot?.status === 'TIMED_OUT' ||
      state.snapshot?.status === 'FAILED' ||
      state.snapshot?.status === 'SUCCEEDED'
    )
      return {
        ...state,
        mode: 'stopped',
        issue: null,
      }
    // 合法新版本
    if (!state.snapshot || event.snapshot.version > state.snapshot.version) {
      if (
        event.snapshot.status === 'SUCCEEDED' ||
        event.snapshot.status === 'FAILED' ||
        event.snapshot.status === 'TIMED_OUT'
      )
        return {
          ...state,
          snapshot: event.snapshot,
          issue: null,
          mode: 'stopped',
        }
      else {
        return {
          ...state,
          snapshot: event.snapshot,
          issue: null,
        }
      }
    }
    // 重复版本
    if (event.snapshot.version === state.snapshot.version) {
      return {
        ...state,
        issue: null,
      }
    }
  }
  return state
}
