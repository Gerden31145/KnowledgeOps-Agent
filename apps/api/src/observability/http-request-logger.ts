import { randomUUID } from 'node:crypto'

import type { StructuredLogger } from '@knowledgeops/observability'

interface HttpRequest {
  method: string
  url: string
  originalUrl?: string
  headers: Record<string, string | string[] | undefined>
  requestId?: string
}

interface HttpResponse {
  statusCode: number
  setHeader(name: string, value: string): void
  once(event: 'finish', listener: () => void): void
}

const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export function resolveRequestId(candidate: string | string[] | undefined) {
  return typeof candidate === 'string' && requestIdPattern.test(candidate)
    ? candidate
    : randomUUID()
}

export function requestPath(requestUrl: string) {
  try {
    return new URL(requestUrl, 'http://local.invalid').pathname
  } catch {
    return requestUrl.split('?')[0] ?? '/'
  }
}

export function createHttpRequestLogger(logger: StructuredLogger) {
  return (request: HttpRequest, response: HttpResponse, next: () => void) => {
    const requestId = resolveRequestId(request.headers['x-request-id'])
    const startedAt = performance.now()

    request.requestId = requestId
    response.setHeader('x-request-id', requestId)
    // 注册回调：请求结束之后打印日志
    response.once('finish', () => {
      logger.log(
        {
          event: 'http.request.completed',
          requestId,
          method: request.method,
          path: requestPath(request.originalUrl ?? request.url),
          statusCode: response.statusCode,
          durationMs: Number((performance.now() - startedAt).toFixed(2)),
        },
        'Http',
      )
    })

    next()
  }
}
