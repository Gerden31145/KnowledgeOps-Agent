import { describe, expect, it } from 'vitest'

import { StructuredLogger, type StructuredLogEntry } from '../src/index.js'

describe('StructuredLogger', () => {
  it('writes machine-readable context and redacts sensitive keys', () => {
    const entries: StructuredLogEntry[] = []
    const logger = new StructuredLogger({
      service: 'api',
      now: () => new Date('2026-08-03T03:00:00.000Z'),
      write: (entry) => entries.push(entry),
    })

    logger.log(
      {
        event: 'http.request.completed',
        requestId: 'request-1',
        statusCode: 200,
        password: 'must-not-leak',
        promptTokenCount: 320,
      },
      'Http',
    )

    expect(entries).toEqual([
      {
        timestamp: '2026-08-03T03:00:00.000Z',
        level: 'info',
        service: 'api',
        context: 'Http',
        message: 'http.request.completed',
        data: {
          requestId: 'request-1',
          statusCode: 200,
          password: '[REDACTED]',
          promptTokenCount: 320,
        },
      },
    ])
  })

  it('honours the configured minimum level', () => {
    const entries: StructuredLogEntry[] = []
    const logger = new StructuredLogger({
      service: 'worker',
      minimumLevel: 'warn',
      write: (entry) => entries.push(entry),
    })

    logger.debug('not emitted')
    logger.warn('worker.slow')

    expect(entries).toHaveLength(1)
    expect(entries[0]?.message).toBe('worker.slow')
  })
})
