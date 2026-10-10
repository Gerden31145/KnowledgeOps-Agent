import 'reflect-metadata'
import { createHmac, randomUUID } from 'node:crypto'
import type { DatabaseClient } from '@knowledgeops/database'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { GitHubWebhookController } from '../src/webhooks/github-webhook.controller.js'
import { GitHubWebhookService } from '../src/webhooks/github-webhook.service.js'
import { readApiEnvironment } from '../src/config/environment.js'
import { API_ENVIRONMENT } from '../src/config/config.module.js'
import { DatabaseService } from '../src/database/database.service.js'
import { AppModule } from '../src/app.module.js'

const secret = 'synthetic-r05-webhook-secret-only-32'
const input = () => ({
  rawBody: Buffer.from('{}'),
  signature: 'fixture-signature',
  deliveryId: randomUUID(),
  eventType: 'push',
})

describe('R05 pre-persistence checks (HMAC has dedicated acceptance coverage)', () => {
  const transaction = vi.fn()
  const database = { $transaction: transaction } as unknown as DatabaseClient

  it('keeps missing configuration separate from invalid credentials and does not access storage', async () => {
    transaction.mockClear()
    await expect(
      new GitHubWebhookService(database, undefined).receive(input()),
    ).rejects.toMatchObject({
      status: 503,
    })
    const rejectSignature = vi.fn(() => false)
    await expect(
      new GitHubWebhookService(database, secret, rejectSignature).receive(input()),
    ).rejects.toMatchObject({
      status: 401,
    })
    expect(rejectSignature).toHaveBeenCalledOnce()
    expect(transaction).not.toHaveBeenCalled()
  })

  it('rejects malformed metadata, missing push fields and oversized input before storage', async () => {
    transaction.mockClear()
    // A fixture for subsequent validation, NOT an HMAC implementation or real signature proof.
    const service = new GitHubWebhookService(database, secret, () => true)
    for (const invalid of [
      { ...input(), deliveryId: undefined },
      { ...input(), eventType: 'push, ping' },
      input(),
      { ...input(), rawBody: Buffer.from('{') },
    ]) {
      await expect(service.receive(invalid)).rejects.toMatchObject({ status: 400 })
    }
    await expect(
      service.receive({ ...input(), rawBody: Buffer.alloc(100 * 1024 + 1) }),
    ).rejects.toMatchObject({ status: 413 })
    expect(transaction).not.toHaveBeenCalled()
  })

  it('allows an unconfigured endpoint but rejects a weak configured secret without printing it', () => {
    expect(readApiEnvironment({ GITHUB_WEBHOOK_SECRET: '' }).GITHUB_WEBHOOK_SECRET).toBeUndefined()
    expect(readApiEnvironment({ GITHUB_WEBHOOK_SECRET: secret }).GITHUB_WEBHOOK_SECRET).toBe(secret)
    expect(() => readApiEnvironment({ GITHUB_WEBHOOK_SECRET: 'short-private-value' })).toThrow(
      'Invalid API environment fields: GITHUB_WEBHOOK_SECRET',
    )
  })
})

describe('R05 AppModule: real global guard and HMAC, fixture persistence', () => {
  const transaction = vi.fn(async () => ({ received: true }))
  const environment = readApiEnvironment({ GITHUB_WEBHOOK_SECRET: secret })
  const body = '{}'
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
  let app: NestExpressApplication
  let url: string

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(API_ENVIRONMENT)
      .useValue(environment)
      .overrideProvider(DatabaseService)
      .useValue({ client: { $transaction: transaction } })
      .compile()
    app = module.createNestApplication<NestExpressApplication>({ logger: false, rawBody: true })
    app.useBodyParser('json', { limit: '100kb', inflate: false })
    await app.listen(0, '127.0.0.1')
    url = await app.getUrl()
  })

  afterAll(async () => {
    await app?.close()
  })

  const send = (rawBody: string, signed: string | undefined) =>
    fetch(`${url}/webhooks/github`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'ping',
        'x-github-delivery': randomUUID(),
        ...(signed === undefined ? {} : { 'x-hub-signature-256': signed }),
      },
      body: rawBody,
    })

  it('accepts a signed server notification without browser Origin or session Cookie', async () => {
    transaction.mockClear()
    const response = await send(body, signature)
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ received: true })
    expect(transaction).toHaveBeenCalledOnce()
  })

  it('still rejects missing or mismatched signatures before persistence', async () => {
    transaction.mockClear()
    for (const [rawBody, signed] of [
      [body, undefined],
      [`${body} `, signature],
    ] as const) {
      const response = await send(rawBody, signed)
      expect(response.status).toBe(401)
      expect(await response.json()).toMatchObject({ code: 'WEBHOOK_SIGNATURE_INVALID' })
    }
    expect(transaction).not.toHaveBeenCalled()
  })

  it('keeps browser routes protected by session and Origin checks', async () => {
    const session = await fetch(`${url}/auth/session`)
    expect(session.status).toBe(401)
    await session.arrayBuffer()
    for (const origin of [undefined, 'https://untrusted.example']) {
      const logout = await fetch(`${url}/auth/logout`, {
        method: 'POST',
        headers: origin === undefined ? {} : { origin },
      })
      expect(logout.status).toBe(403)
      await logout.arrayBuffer()
    }
    const allowedLogout = await fetch(`${url}/auth/logout`, {
      method: 'POST',
      headers: { origin: environment.WEB_ORIGIN },
    })
    expect(allowedLogout.status).toBe(204)
    await allowedLogout.arrayBuffer()
  })
})

describe('R05 HTTP adapter: real Nest parser, fixture service', () => {
  const receive = vi.fn(async () => ({ received: true }))
  let app: NestExpressApplication
  let url: string

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [GitHubWebhookController],
      providers: [{ provide: GitHubWebhookService, useValue: { receive } }],
    }).compile()
    app = module.createNestApplication<NestExpressApplication>({ logger: false, rawBody: true })
    app.useBodyParser('json', { limit: '100kb', inflate: false })
    await app.listen(0, '127.0.0.1')
    url = `${await app.getUrl()}/webhooks/github`
  })

  afterAll(async () => {
    await app?.close()
  })

  it('forwards original UTF-8 bytes and headers without requiring a browser Cookie', async () => {
    receive.mockClear()
    const body = '{ "message": "合成笔记", "value": 1 }\n'
    const deliveryId = randomUUID()
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': deliveryId,
        'x-github-event': 'push',
        'x-hub-signature-256': 'fixture-signature',
      },
      body,
    })
    expect(response.status).toBe(202)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ received: true })
    expect(receive).toHaveBeenCalledExactlyOnceWith({
      rawBody: Buffer.from(body),
      signature: 'fixture-signature',
      deliveryId,
      eventType: 'push',
    })
  })

  it('rejects unsupported media, malformed JSON and oversized JSON without calling the service', async () => {
    receive.mockClear()
    for (const [type, body, expected] of [
      ['text/plain', '{}', 415],
      ['application/json', '{', 400],
      ['application/json', JSON.stringify({ text: 'x'.repeat(100 * 1024) }), 413],
    ] as const) {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': type }, body })
      expect(response.status).toBe(expected)
      await response.arrayBuffer()
    }
    expect(receive).not.toHaveBeenCalled()
  })
})
