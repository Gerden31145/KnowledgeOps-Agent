import { describe, expect, it } from 'vitest'

import { readApiEnvironment } from '../src/config/environment.js'

describe('API environment', () => {
  it('coerces the API port and preserves explicit connection URLs', () => {
    const environment = readApiEnvironment({
      API_PORT: '4100',
      DATABASE_URL: 'postgresql://user:password@127.0.0.1:5432/database',
      REDIS_URL: 'redis://127.0.0.1:6380',
    })

    expect(environment.API_PORT).toBe(4100)
    expect(environment.REDIS_URL).toBe('redis://127.0.0.1:6380')
  })

  it('fails fast for an invalid port', () => {
    expect(() => readApiEnvironment({ API_PORT: '70000' })).toThrow(
      'Invalid API environment fields: API_PORT',
    )
  })

  it('rejects an unknown structured log level', () => {
    expect(() => readApiEnvironment({ LOG_LEVEL: 'trace' })).toThrow(
      'Invalid API environment fields: LOG_LEVEL',
    )
  })
})
