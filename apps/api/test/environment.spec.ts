import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'

import { readApiEnvironment } from '../src/config/environment.js'

describe('API environment', () => {
  it('defaults new plan runs to the course-only v3 contract', () => {
    const environment = readApiEnvironment({})
    expect(environment.PLAN_GENERATION_PROMPT_VERSION).toBe('plan-generation-v3')
    expect(environment.PLAN_GENERATION_OUTPUT_SCHEMA_VERSION).toBe('plan-generation-output-v3')
  })

  it('uses independent deadlines for plan and course generation', () => {
    const environment = readApiEnvironment({})
    expect(environment.PLAN_GENERATION_TIMEOUT_MS).toBe(180_000)
    expect(environment.COURSE_GENERATION_TIMEOUT_MS).toBe(600_000)
    expect(
      readApiEnvironment({ COURSE_GENERATION_TIMEOUT_MS: '420000' }).COURSE_GENERATION_TIMEOUT_MS,
    ).toBe(420_000)
  })

  it('accepts an optional absolute private key path without loading or exposing the key', () => {
    expect(readApiEnvironment({}).GITHUB_APP_PRIVATE_KEY_PATH).toBeUndefined()
    expect(
      readApiEnvironment({ GITHUB_APP_PRIVATE_KEY_PATH: '' }).GITHUB_APP_PRIVATE_KEY_PATH,
    ).toBeUndefined()
    const keyPath = resolve('.secrets', 'github-app.pem')
    expect(
      readApiEnvironment({ GITHUB_APP_PRIVATE_KEY_PATH: keyPath }).GITHUB_APP_PRIVATE_KEY_PATH,
    ).toBe(keyPath)
    expect(() =>
      readApiEnvironment({ GITHUB_APP_PRIVATE_KEY_PATH: '.secrets/fixture-only-private-key.pem' }),
    ).toThrow('Invalid API environment fields: GITHUB_APP_PRIVATE_KEY_PATH')
  })

  it('reports invalid URL field names instead of throwing with the raw configured value', () => {
    expect(() => readApiEnvironment({ WEB_ORIGIN: 'invalid-secret-url' })).toThrow(
      'Invalid API environment fields: WEB_ORIGIN',
    )
    expect(() => readApiEnvironment({ GITHUB_APP_CALLBACK_URL: 'invalid-secret-url' })).toThrow(
      'Invalid API environment fields: GITHUB_APP_CALLBACK_URL',
    )
  })
  it('requires credentials and HTTPS in production without including secrets in errors', () => {
    expect(() => readApiEnvironment({ NODE_ENV: 'production' })).toThrow('WEB_ORIGIN')
    expect(() =>
      readApiEnvironment({ NODE_ENV: 'production', WEB_ORIGIN: 'https://knowledgeops.example' }),
    ).toThrow('GITHUB_APP_CLIENT_ID')
    const configured = {
      NODE_ENV: 'production',
      WEB_ORIGIN: 'https://knowledgeops.example',
      GITHUB_APP_CLIENT_ID: 'client',
      GITHUB_APP_CLIENT_SECRET: 'secret',
      GITHUB_APP_CALLBACK_URL: 'https://knowledgeops.example/api/auth/github/callback',
    }
    expect(readApiEnvironment(configured).NODE_ENV).toBe('production')
    expect(() =>
      readApiEnvironment({
        ...configured,
        GITHUB_APP_CALLBACK_URL: 'http://knowledgeops.example/auth/github/callback',
      }),
    ).toThrow('GITHUB_APP_CALLBACK_URL')
    expect(() => readApiEnvironment({ WEB_ORIGIN: 'http://remote.example' })).toThrow('WEB_ORIGIN')
    expect(() =>
      readApiEnvironment({
        WEB_ORIGIN: 'http://localhost:3000',
        GITHUB_APP_CALLBACK_URL: 'http://127.0.0.1:4000/auth/github/callback',
      }),
    ).toThrow('GITHUB_APP_CALLBACK_URL')
  })
  it('accepts the dedicated HTTPS API subdomain but rejects unrelated hosts and scheme changes', () => {
    const source = {
      NODE_ENV: 'production',
      WEB_ORIGIN: 'https://knowops.site',
      GITHUB_APP_CLIENT_ID: 'client',
      GITHUB_APP_CLIENT_SECRET: 'fixture-secret',
      GITHUB_APP_CALLBACK_URL: 'https://api.knowops.site/auth/github/callback',
    }
    expect(readApiEnvironment(source).GITHUB_APP_CALLBACK_URL).toBe(source.GITHUB_APP_CALLBACK_URL)
    for (const host of ['other.site', 'knowops.site.other.site', 'other.knowops.site']) {
      expect(() =>
        readApiEnvironment({
          ...source,
          GITHUB_APP_CALLBACK_URL: `https://${host}/auth/github/callback`,
        }),
      ).toThrow('GITHUB_APP_CALLBACK_URL')
    }
    expect(() =>
      readApiEnvironment({
        ...source,
        GITHUB_APP_CALLBACK_URL: 'http://api.knowops.site/auth/github/callback',
      }),
    ).toThrow('GITHUB_APP_CALLBACK_URL')
    expect(() =>
      readApiEnvironment({
        WEB_ORIGIN: 'http://localhost:3000',
        GITHUB_APP_CALLBACK_URL: 'http://api.localhost:4000/auth/github/callback',
      }),
    ).toThrow('GITHUB_APP_CALLBACK_URL')
  })
  it('coerces the API port and preserves explicit connection URLs', () => {
    const environment = readApiEnvironment({
      API_PORT: '4100',
      DATABASE_URL: 'postgresql://user:password@127.0.0.1:5432/database',
      REDIS_URL: 'redis://127.0.0.1:6380',
      WEB_ORIGIN: 'http://127.0.0.1:3100',
    })

    expect(environment.API_PORT).toBe(4100)
    expect(environment.REDIS_URL).toBe('redis://127.0.0.1:6380')
    expect(environment.WEB_ORIGIN).toBe('http://127.0.0.1:3100')
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
