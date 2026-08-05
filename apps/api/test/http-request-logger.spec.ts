import { describe, expect, it } from 'vitest'

import { requestPath, resolveRequestId } from '../src/observability/http-request-logger.js'

describe('HTTP request ID', () => {
  it('preserves a bounded safe upstream request ID', () => {
    expect(resolveRequestId('edge:request-123')).toBe('edge:request-123')
  })

  it('replaces ambiguous or unsafe request IDs', () => {
    expect(resolveRequestId(['one', 'two'])).toMatch(/^[0-9a-f-]{36}$/)
    expect(resolveRequestId('contains whitespace')).toMatch(/^[0-9a-f-]{36}$/)
    expect(resolveRequestId('x'.repeat(129))).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('never includes query parameters in the structured request path', () => {
    expect(requestPath('/auth/github/callback?code=secret-code&state=secret-state')).toBe(
      '/auth/github/callback',
    )
  })
})
