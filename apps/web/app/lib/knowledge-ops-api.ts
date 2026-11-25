import { apiErrorResponseSchema, errorCodeSchema } from '@knowledgeops/contracts'
import type { ZodType } from 'zod'

export class KnowledgeOpsApiError extends Error {
  override readonly name = 'KnowledgeOpsApiError'

  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details: unknown,
  ) {
    super(message)
  }
}

export function boundedSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(30_000)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

export function jsonRequest(method: 'POST', body: unknown): RequestInit {
  return {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method,
  }
}

export async function request<T>(
  baseUrl: string,
  path: string,
  schema: ZodType<T>,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(apiUrl(baseUrl, path), { ...init, credentials: 'include' })
  const payload = await readJson(response)

  if (!response.ok) {
    const parsedError = readApiError(payload)
    throw new KnowledgeOpsApiError(
      parsedError?.message ?? `Request failed with ${response.status}`,
      response.status,
      parsedError?.code ?? 'UNEXPECTED_RESPONSE',
      payload,
    )
  }

  return schema.parse(payload)
}

function readApiError(payload: unknown): { code: string; message: string } | null {
  const canonical = apiErrorResponseSchema.safeParse(payload)
  if (canonical.success) return canonical.data.error
  if (!payload || typeof payload !== 'object') return null

  const code = errorCodeSchema.safeParse(Reflect.get(payload, 'code'))
  const message = Reflect.get(payload, 'message')

  return code.success && typeof message === 'string' && message.length > 0
    ? { code: code.data, message }
    : null
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()

  if (!text) return null

  try {
    return JSON.parse(text) as unknown
  } catch (error: unknown) {
    throw new KnowledgeOpsApiError(
      'Server returned invalid JSON',
      response.status,
      'UNEXPECTED_RESPONSE',
      { cause: error instanceof Error ? error.message : String(error) },
    )
  }
}

export function apiUrl(baseUrl: string, path: string): URL {
  // 保留反向代理的 /api 前缀；业务路径均由客户端代码定义，不接收任意外部 URL。
  return new URL(path.replace(/^\//, ''), baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
}
