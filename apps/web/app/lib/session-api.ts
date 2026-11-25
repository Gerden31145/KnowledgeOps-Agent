import { sessionResponseSchema, type SessionResponse } from '@knowledgeops/contracts'
import { z } from 'zod'
import { request } from './knowledge-ops-api'

export interface SessionApi {
  getSession(): Promise<SessionResponse>
  logout(): Promise<null>
}

export function createSessionApi(baseUrl: string): SessionApi {
  return {
    getSession: () =>
      request(baseUrl, '/auth/session', sessionResponseSchema, {
        signal: AbortSignal.timeout(10_000),
      }),
    logout: () =>
      request(baseUrl, '/auth/logout', z.null(), {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
      }),
  }
}
