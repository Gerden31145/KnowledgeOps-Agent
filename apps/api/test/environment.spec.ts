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

  it('parses one or two public model catalog entries without credential fields', () => {
    const environment = readApiEnvironment({
      PLAN_GENERATION_MODELS_JSON: JSON.stringify([
        {
          id: 'primary-model',
          label: 'Primary model',
          model: 'provider-model-name',
        },
        { id: 'backup-model', model: 'second-provider-model' },
      ]),
    })

    expect(environment.PLAN_GENERATION_MODELS_JSON).toEqual([
      {
        id: 'primary-model',
        label: 'Primary model',
        model: 'provider-model-name',
      },
      { id: 'backup-model', model: 'second-provider-model' },
    ])
  })

  it('rejects duplicate model IDs and secret-shaped catalog properties', () => {
    expect(() =>
      readApiEnvironment({
        PLAN_GENERATION_MODELS_JSON: JSON.stringify([
          { id: 'same-model', model: 'first' },
          { id: 'same-model', model: 'second' },
        ]),
      }),
    ).toThrow('Invalid API environment fields: PLAN_GENERATION_MODELS_JSON.1.id')

    expect(() =>
      readApiEnvironment({
        PLAN_GENERATION_MODELS_JSON: JSON.stringify([
          {
            id: 'primary-model',
            model: 'provider-model-name',
            apiKey: 'must-not-be-catalog-data',
          },
        ]),
      }),
    ).toThrow('Invalid API environment fields: PLAN_GENERATION_MODELS_JSON.0')
  })

  it('rejects a provider that has no production adapter', () => {
    expect(() =>
      readApiEnvironment({
        PLAN_GENERATION_PROVIDER: 'unsupported',
      }),
    ).toThrow('Invalid API environment fields: PLAN_GENERATION_PROVIDER')
  })
})
