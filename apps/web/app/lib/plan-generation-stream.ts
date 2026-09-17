import {
  entityIdSchema,
  planGenerationRunStatusResponseSchema,
  planGenerationStreamErrorSchema,
  type PlanGenerationRunStatusResponse,
  type PlanGenerationStreamError,
} from '@knowledgeops/contracts'

import { apiUrl } from './knowledge-ops-api'

export type PlanStreamIssue =
  | { kind: 'connection' }
  | { kind: 'protocol' }
  | { kind: 'server'; code: PlanGenerationStreamError['code'] }

export interface PlanStreamHandlers {
  onOpen(): void
  onSnapshot(snapshot: PlanGenerationRunStatusResponse): void
  onIssue(issue: PlanStreamIssue): void
}

// 仅为浏览器传输端口：不读写 Query 缓存，不决定版本归并、重连校准或轮询策略。
// 调用者须在终态/切换/卸载时 close；业务协调由 R14/C2 接入。
export function subscribePlanGenerationRun(
  baseUrl: string,
  runId: string,
  handlers: PlanStreamHandlers,
): { close(): void } {
  entityIdSchema.parse(runId)
  const source = new EventSource(apiUrl(baseUrl, `/plan-generation-runs/${runId}/events`), {
    withCredentials: true,
  })
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    source.removeEventListener('open', onOpen)
    source.removeEventListener('error', onError)
    source.removeEventListener('snapshot', onSnapshot)
    source.removeEventListener('stream-error', onStreamError)
    source.close()
  }
  const invalid = () => {
    close()
    handlers.onIssue({ kind: 'protocol' })
  }
  const onOpen = () => {
    if (!closed) handlers.onOpen()
  }
  // 网络错误只通知上层；浏览器自己重连，不把断网改写成 Run FAILED。
  const onError = () => {
    if (!closed) handlers.onIssue({ kind: 'connection' })
  }
  const onSnapshot = (event: MessageEvent<string>) => {
    if (closed) return
    let snapshot: PlanGenerationRunStatusResponse
    try {
      snapshot = planGenerationRunStatusResponseSchema.parse(JSON.parse(event.data))
    } catch {
      invalid()
      return
    }
    if (snapshot.generationRunId !== runId) {
      invalid()
      return
    }
    handlers.onSnapshot(snapshot)
  }
  const onStreamError = (event: MessageEvent<string>) => {
    if (closed) return
    let error: PlanGenerationStreamError
    try {
      error = planGenerationStreamErrorSchema.parse(JSON.parse(event.data))
    } catch {
      invalid()
      return
    }
    close()
    handlers.onIssue({ kind: 'server', code: error.code })
  }
  source.addEventListener('open', onOpen)
  source.addEventListener('error', onError)
  source.addEventListener('snapshot', onSnapshot)
  source.addEventListener('stream-error', onStreamError)
  return { close }
}
