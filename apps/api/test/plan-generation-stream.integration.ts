import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import { createDatabaseClient } from '@knowledgeops/database'
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { AppModule } from '../src/app.module.js'
import { API_ENVIRONMENT } from '../src/config/config.module.js'
import { readApiEnvironment } from '../src/config/environment.js'
import { DatabaseService } from '../src/database/database.service.js'
import { hashToken, opaqueToken } from '../src/identity/auth-http.js'

const environment = readApiEnvironment({
  ...process.env,
  NODE_ENV: 'test',
  WEB_ORIGIN: 'http://127.0.0.1:3000',
})

// 解析真实 HTTP 分块；不假设一个 TCP chunk 恰好是一条事件。
async function* frames(response: Response) {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) return
      buffered += decoder.decode(value, { stream: true })
      let end: number
      while ((end = buffered.indexOf('\n\n')) >= 0) {
        const frame = buffered.slice(0, end)
        buffered = buffered.slice(end + 2)
        const event = /^event: (.+)$/m.exec(frame)?.[1]
        const data = /^data: (.+)$/m.exec(frame)?.[1]
        if (event && data) yield { event, data: JSON.parse(data) as unknown }
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}

describe('R13 authenticated SSE over HTTP and real PostgreSQL', () => {
  const database = new DatabaseService(environment.DATABASE_URL)
  // 独立连接模拟 Worker 写入；不经 API 内存通知、不访问模型/GitHub。
  const writer = createDatabaseClient(environment.DATABASE_URL)
  const ownerId = randomUUID(),
    otherId = randomUUID(),
    goalId = randomUUID(),
    runId = randomUUID()
  const token = opaqueToken(),
    otherToken = opaqueToken(),
    expiredToken = opaqueToken()
  const aborts: AbortController[] = []
  let app: INestApplication
  let baseUrl: string
  beforeAll(async () => {
    await database.client.user.createMany({
      data: [
        { id: ownerId, githubLogin: 'r13-fixture-owner' },
        { id: otherId, githubLogin: 'r13-fixture-other' },
      ],
    })
    await database.client.learningGoal.create({
      data: {
        id: goalId,
        userId: ownerId,
        title: 'R13 fixture',
        currentLevel: 'fixture',
        weeklyMinutes: 120,
        deadline: new Date('2026-09-30'),
        planGenerationRuns: {
          create: {
            id: runId,
            modelCatalogId: 'fixture',
            modelProvider: 'fixture',
            modelName: 'private-model-name',
            promptVersion: 'fixture',
            outputSchemaVersion: 'fixture',
            deadlineAt: new Date(Date.now() + 120_000),
          },
        },
      },
    })
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(API_ENVIRONMENT)
      .useValue(environment)
      .overrideProvider(DatabaseService)
      .useValue(database)
      .compile()
    app = module.createNestApplication({ logger: false })
    app.enableCors({ origin: environment.WEB_ORIGIN, credentials: true })
    await app.listen(0, '127.0.0.1')
    baseUrl = await app.getUrl()
  })
  beforeEach(async () => {
    await database.client.planGenerationRun.update({
      where: { id: runId },
      data: {
        status: 'QUEUED',
        version: 0,
        startedAt: null,
        finishedAt: null,
        errorCode: null,
        errorMessage: null,
      },
    })
    for (const [sessionToken, userId, expiresAt] of [
      [token, ownerId, new Date(Date.now() + 120_000)],
      [otherToken, otherId, new Date(Date.now() + 120_000)],
      [expiredToken, ownerId, new Date(Date.now() - 1000)],
    ] as const) {
      await database.client.session.upsert({
        where: { tokenHash: hashToken(sessionToken) },
        update: { expiresAt },
        create: { tokenHash: hashToken(sessionToken), userId, expiresAt },
      })
    }
  })
  afterEach(() => {
    for (const abort of aborts.splice(0)) abort.abort()
  })
  afterAll(async () => {
    try {
      await database.client.user.deleteMany({ where: { id: { in: [ownerId, otherId] } } })
    } finally {
      await writer.$disconnect()
      if (app) await app.close()
      else await database.onApplicationShutdown()
    }
  })
  const headers = (value = token) => ({
    cookie: `knowledgeops_session=${value}`,
    origin: environment.WEB_ORIGIN,
  })
  const connect = (value = token, id: string = runId, extraHeaders = {}) => {
    const abort = new AbortController()
    aborts.push(abort)
    return fetch(`${baseUrl}/plan-generation-runs/${id}/events`, {
      headers: { ...headers(value), ...extraHeaders },
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]),
    })
  }

  it('rejects missing/forged/expired sessions and invalid IDs before opening an event stream', async () => {
    for (const value of ['', opaqueToken(), expiredToken]) {
      const response = await connect(value)
      expect(response.status).toBe(401)
      expect(response.headers.get('content-type')).not.toContain('text/event-stream')
    }
    expect((await connect(token, 'invalid')).status).toBe(400)
  })
  it('conceals whether a run is missing or belongs to someone else', async () => {
    const foreign = await connect(otherToken)
    const missing = await connect(token, randomUUID())
    expect(foreign.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(await foreign.json()).toEqual(await missing.json())
  })
  it('streams independent database writes and reconnects with the latest terminal snapshot (not history)', async () => {
    const response = await connect()
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(response.headers.get('access-control-allow-origin')).toBe(environment.WEB_ORIGIN)
    expect(response.headers.get('access-control-allow-credentials')).toBe('true')
    expect(response.headers.get('x-accel-buffering')).toBe('no')
    const events = frames(response)
    const first = await events.next()
    expect(first.value).toMatchObject({
      event: 'snapshot',
      data: { generationRunId: runId, status: 'QUEUED', version: 0 },
    })
    await writer.planGenerationRun.update({
      where: { id: runId },
      data: { status: 'RUNNING', version: { increment: 1 }, startedAt: new Date() },
    })
    expect((await events.next()).value).toMatchObject({ data: { status: 'RUNNING', version: 1 } })
    await writer.planGenerationRun.update({
      where: { id: runId },
      data: {
        status: 'FAILED',
        version: { increment: 1 },
        finishedAt: new Date(),
        errorCode: 'MODEL_UPSTREAM_ERROR',
        errorMessage: 'Fixture failure',
      },
    })
    const terminal = (await events.next()).value
    expect(terminal).toMatchObject({ data: { status: 'FAILED', version: 2 } })
    expect((await events.next()).done).toBe(true)
    const http = await fetch(`${baseUrl}/plan-generation-runs/${runId}`, { headers: headers() })
    expect(await http.json()).toEqual(terminal?.data)
    const restored = frames(await connect(token, runId, { 'Last-Event-ID': 'obsolete-cursor' }))
    expect((await restored.next()).value).toEqual(terminal)
    expect((await restored.next()).done).toBe(true)
    expect(JSON.stringify(terminal)).not.toContain('private-model-name')
  })
  it.each(['revoked', 'expired'])(
    'rechecks a %s session during a long connection and closes without leaking data',
    async (reason) => {
      const events = frames(await connect())
      await events.next()
      if (reason === 'revoked')
        await writer.session.delete({ where: { tokenHash: hashToken(token) } })
      else
        await writer.session.update({
          where: { tokenHash: hashToken(token) },
          data: { expiresAt: new Date(Date.now() - 1) },
        })
      expect((await events.next()).value).toEqual({
        event: 'stream-error',
        data: { code: 'UNAUTHENTICATED' },
      })
      expect((await events.next()).done).toBe(true)
      expect(
        (await writer.planGenerationRun.findUniqueOrThrow({ where: { id: runId } })).status,
      ).toBe('QUEUED')
    },
  )
  it('applies a per-user limit and releases the slot when an HTTP reader disconnects', async () => {
    const readers = []
    for (let i = 0; i < 3; i++) {
      const reader = frames(await connect())
      await reader.next()
      readers.push(reader)
    }
    expect((await connect()).status).toBe(429)
    await readers[0]!.return()
    await expect
      .poll(async () => {
        const response = await connect()
        if (response.ok) await response.body!.cancel()
        return response.status
      })
      .toBe(200)
    for (const reader of readers.slice(1)) await reader.return()
  })
})
