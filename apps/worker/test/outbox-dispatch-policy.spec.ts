import { describe, expect, it } from 'vitest'

import {
  NonRetryableOutboxDispatchError,
  classifyOutboxDispatchFailure,
  sanitizeDispatchErrorMessage,
} from '../src/outbox/outbox-dispatch-error.js'
import { calculateOutboxRetryDelay } from '../src/outbox/outbox-retry-policy.js'

describe('Outbox dispatch retry policy', () => {
  it('uses capped exponential delays based on completed attempts', () => {
    const policy = { baseDelayMs: 1_000, maxDelayMs: 8_000 }

    expect(calculateOutboxRetryDelay(0, policy)).toBe(1_000)
    expect(calculateOutboxRetryDelay(1, policy)).toBe(2_000)
    expect(calculateOutboxRetryDelay(2, policy)).toBe(4_000)
    expect(calculateOutboxRetryDelay(3, policy)).toBe(8_000)
    expect(calculateOutboxRetryDelay(20, policy)).toBe(8_000)
  })

  it('classifies contract failures as non-retryable', () => {
    expect(
      classifyOutboxDispatchFailure(
        new NonRetryableOutboxDispatchError('OUTBOX_PAYLOAD_INVALID', 'payload mismatch'),
      ),
    ).toEqual({
      code: 'OUTBOX_PAYLOAD_INVALID',
      kind: 'NON_RETRYABLE',
      message: 'payload mismatch',
    })
  })

  it('classifies unknown transport failures as retryable Errors', () => {
    expect(classifyOutboxDispatchFailure('connection closed')).toEqual({
      code: 'OUTBOX_TRANSPORT_UNAVAILABLE',
      kind: 'RETRYABLE',
      message: 'connection closed',
    })
  })

  it('redacts credentials before persisting a transport error', () => {
    expect(
      sanitizeDispatchErrorMessage('connect ECONNREFUSED redis://worker:secret@127.0.0.1:6379'),
    ).toBe('connect ECONNREFUSED redis://[REDACTED]@127.0.0.1:6379')
  })
})
