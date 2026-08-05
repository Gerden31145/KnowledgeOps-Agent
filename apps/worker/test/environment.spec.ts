import { describe, expect, it } from 'vitest'

import { readWorkerEnvironment } from '../src/config/environment.js'

describe('Worker environment', () => {
  it('coerces a bounded concurrency value', () => {
    const environment = readWorkerEnvironment({ WORKER_CONCURRENCY: '4' })

    expect(environment.WORKER_CONCURRENCY).toBe(4)
  })

  it('rejects unsafe concurrency before the worker starts', () => {
    expect(() => readWorkerEnvironment({ WORKER_CONCURRENCY: '0' })).toThrow(
      'Invalid Worker environment fields: WORKER_CONCURRENCY',
    )
  })
})
