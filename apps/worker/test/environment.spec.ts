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

  it('coerces bounded BullMQ and outbox settings', () => {
    const environment = readWorkerEnvironment({
      BULLMQ_JOB_ATTEMPTS: '4',
      BULLMQ_JOB_BACKOFF_MS: '500',
      OUTBOX_BATCH_SIZE: '10',
      OUTBOX_POLL_INTERVAL_MS: '250',
      OUTBOX_RETRY_BASE_DELAY_MS: '200',
      OUTBOX_RETRY_MAX_DELAY_MS: '5000',
    })

    expect(environment).toMatchObject({
      BULLMQ_JOB_ATTEMPTS: 4,
      BULLMQ_JOB_BACKOFF_MS: 500,
      OUTBOX_BATCH_SIZE: 10,
      OUTBOX_POLL_INTERVAL_MS: 250,
      OUTBOX_RETRY_BASE_DELAY_MS: 200,
      OUTBOX_RETRY_MAX_DELAY_MS: 5000,
    })
  })

  it('rejects a retry cap below the initial retry delay', () => {
    expect(() =>
      readWorkerEnvironment({
        OUTBOX_RETRY_BASE_DELAY_MS: '5000',
        OUTBOX_RETRY_MAX_DELAY_MS: '1000',
      }),
    ).toThrow('Invalid Worker environment fields: OUTBOX_RETRY_MAX_DELAY_MS')
  })
})
