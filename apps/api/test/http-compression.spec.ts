import 'reflect-metadata'
import type { ServerResponse } from 'node:http'
import { Controller, Get, Res, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHttpCompression } from '../src/http-compression.js'

const payload = 'event-loop-'.repeat(200)

@Controller()
class CompressionFixtureController {
  @Get('large')
  large() {
    return { payload }
  }

  @Get('small')
  small() {
    return { status: 'ok' }
  }

  @Get('events')
  events(@Res() response: ServerResponse) {
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    response.setHeader('Cache-Control', 'no-store, no-transform')
    response.setHeader('X-Accel-Buffering', 'no')
    response.end(': heartbeat\n\n')
  }
}

describe('HTTP response compression', () => {
  let app: INestApplication
  let baseUrl: string

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [CompressionFixtureController],
    }).compile()
    app = module.createNestApplication({ logger: false })
    app.use(createHttpCompression())
    await app.listen(0, '127.0.0.1')
    baseUrl = await app.getUrl()
  })

  afterAll(async () => {
    if (app) await app.close()
  })

  it('compresses large JSON for gzip clients and preserves identity responses', async () => {
    const compressed = await fetch(`${baseUrl}/large`, {
      headers: { 'accept-encoding': 'gzip' },
    })
    expect(compressed.status).toBe(200)
    expect(compressed.headers.get('content-encoding')).toBe('gzip')
    expect(compressed.headers.get('vary')).toContain('Accept-Encoding')
    expect(await compressed.json()).toEqual({ payload })

    const identity = await fetch(`${baseUrl}/large`, {
      headers: { 'accept-encoding': 'identity' },
    })
    expect(identity.headers.get('content-encoding')).toBeNull()
    expect(await identity.json()).toEqual({ payload })
  })

  it('does not spend compression work on responses below the threshold', async () => {
    const response = await fetch(`${baseUrl}/small`, {
      headers: { 'accept-encoding': 'gzip' },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-encoding')).toBeNull()
    expect(await response.json()).toEqual({ status: 'ok' })
  })

  it('never compresses SSE and preserves its no-transform headers', async () => {
    const response = await fetch(`${baseUrl}/events`, {
      headers: { 'accept-encoding': 'gzip' },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(response.headers.get('content-encoding')).toBeNull()
    expect(response.headers.get('cache-control')).toBe('no-store, no-transform')
    expect(response.headers.get('x-accel-buffering')).toBe('no')
    expect(await response.text()).toBe(': heartbeat\n\n')
  })
})
