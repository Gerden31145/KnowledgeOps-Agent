import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'

import { readWorkerEnvironment } from '../src/config/environment.js'

describe('Worker environment', () => {
  it('requires explicit model prices and credentials before enabling note consumption', () => {
    expect(readWorkerEnvironment({}).NOTE_VERIFICATION_MODEL_JSON).toBeUndefined()
    const model = {
      catalogId: 'glm-5-3',
      modelName: 'glm-5.3',
      currency: 'CNY',
      inputMicrounitsPerMillionTokens: 8_000_000,
      outputMicrounitsPerMillionTokens: 28_000_000,
    }
    const source = {
      OPENAI_API_KEY: 'fixture',
      NOTE_VERIFICATION_MODEL_JSON: JSON.stringify(model),
    }
    expect(readWorkerEnvironment(source).NOTE_VERIFICATION_MODEL_JSON).toEqual(model)
    expect(() => readWorkerEnvironment({ ...source, OPENAI_API_KEY: '' })).toThrow('OPENAI_API_KEY')
    expect(() =>
      readWorkerEnvironment({ ...source, NOTE_VERIFICATION_MODEL_JSON: '{broken' }),
    ).toThrow('NOTE_VERIFICATION_MODEL_JSON')
    expect(() =>
      readWorkerEnvironment({
        ...source,
        NOTE_VERIFICATION_MODEL_JSON: JSON.stringify({
          ...model,
          inputMicrounitsPerMillionTokens: -1,
        }),
      }),
    ).toThrow('NOTE_VERIFICATION_MODEL_JSON')
  })
  it('keeps GitHub App settings optional and accepts only absolute private-key paths', () => {
    expect(readWorkerEnvironment({}).GITHUB_APP_CLIENT_ID).toBeUndefined()
    expect(
      readWorkerEnvironment({ GITHUB_APP_PRIVATE_KEY_PATH: ' ' }).GITHUB_APP_PRIVATE_KEY_PATH,
    ).toBeUndefined()
    const path = resolve('.secrets', 'fixture-only.pem')
    expect(
      readWorkerEnvironment({
        GITHUB_APP_CLIENT_ID: 'fixture-client',
        GITHUB_APP_PRIVATE_KEY_PATH: path,
      }),
    ).toMatchObject({ GITHUB_APP_CLIENT_ID: 'fixture-client', GITHUB_APP_PRIVATE_KEY_PATH: path })
    expect(() =>
      readWorkerEnvironment({ GITHUB_APP_PRIVATE_KEY_PATH: 'relative/fixture.pem' }),
    ).toThrow('Invalid Worker environment fields: GITHUB_APP_PRIVATE_KEY_PATH')
  })
  it('defaults to strict schema output and accepts only an explicit supported method', () => {
    expect(readWorkerEnvironment({}).PLAN_GENERATION_OUTPUT_METHOD).toBe('jsonSchema')
    expect(
      readWorkerEnvironment({ PLAN_GENERATION_OUTPUT_METHOD: 'jsonMode' })
        .PLAN_GENERATION_OUTPUT_METHOD,
    ).toBe('jsonMode')
    expect(() => readWorkerEnvironment({ PLAN_GENERATION_OUTPUT_METHOD: 'text' })).toThrow(
      'Invalid Worker environment fields: PLAN_GENERATION_OUTPUT_METHOD',
    )
  })

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

  it('normalizes blank optional model secrets and bounds the timeout sweep', () => {
    const environment = readWorkerEnvironment({
      OPENAI_API_KEY: '',
      OPENAI_BASE_URL: '',
      PLAN_GENERATION_TIMEOUT_SWEEP_BATCH_SIZE: '8',
      PLAN_GENERATION_TIMEOUT_SWEEP_INTERVAL_MS: '2500',
    })

    expect(environment.OPENAI_API_KEY).toBeUndefined()
    expect(environment.OPENAI_BASE_URL).toBeUndefined()
    expect(environment.PLAN_GENERATION_TIMEOUT_SWEEP_BATCH_SIZE).toBe(8)
    expect(environment.PLAN_GENERATION_TIMEOUT_SWEEP_INTERVAL_MS).toBe(2500)
  })
})
