import {
  isPlanGenerationRunTerminalState,
  type PlanGenerationRunStatusResponse,
  type PlanGenerationStreamError,
} from '@knowledgeops/contracts'
import {
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  type BeforeApplicationShutdown,
} from '@nestjs/common'
import type { ServerResponse } from 'node:http'

import type { AuthRequest } from '../identity/auth-http.js'
import type { AuthService } from '../identity/auth.service.js'
import type { GetPlanGenerationRunService } from './get-plan-generation-run.service.js'
import { PlanGenerationRunNotFoundError } from './plan-generation.errors.js'

export const PLAN_STREAM_INTERVAL_MS = 2000
const HEARTBEAT_MS = 15_000
const MAX_CONNECTIONS = 100
const MAX_PER_USER = 3

export class PlanGenerationStreamService implements BeforeApplicationShutdown {
  private readonly connections = new Map<() => void, string>()
  private shuttingDown = false

  constructor(
    private readonly getRun: GetPlanGenerationRunService,
    private readonly auth: AuthService,
  ) {}

  async open(runId: string, userId: string, request: AuthRequest, response: ServerResponse) {
    if (this.shuttingDown) throw new ServiceUnavailableException()
    const userCount = [...this.connections.values()].filter((id) => id === userId).length
    if (this.connections.size >= MAX_CONNECTIONS || userCount >= MAX_PER_USER) {
      throw new HttpException({ code: 'RATE_LIMITED', message: 'Too many subscriptions' }, 429)
    }

    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let lastSnapshot = ''
    let lastWriteAt = Date.now()
    const stop = () => {
      if (stopped) return
      stopped = true
      clearTimeout(timer)
      this.connections.delete(disconnect)
      response.off('close', stop)
      response.off('error', stop)
      if (response.headersSent && !response.destroyed && !response.writableEnded) response.end()
    }
    const disconnect = () => {
      response.destroy()
      stop()
    }
    // 在第一个 await 前占位，并监听客户端断开（包括初次查询尚未完成的情况）。
    this.connections.set(disconnect, userId)
    response.once('close', stop)
    response.once('error', stop)
    const write = (frame: string) => {
      if (stopped) return
      lastWriteAt = Date.now()
      try {
        // 不积累慢客户端的发送队列；客户端之后重新读取最新快照。
        if (!response.write(frame)) disconnect()
      } catch {
        disconnect()
      }
    }
    const publish = (snapshot: PlanGenerationRunStatusResponse) => {
      const data = JSON.stringify(snapshot)
      if (data !== lastSnapshot) {
        write(`event: snapshot\ndata: ${data}\n\n`)
        lastSnapshot = data
      } else if (Date.now() - lastWriteAt >= HEARTBEAT_MS) {
        write(': heartbeat\n\n')
      }
      if (isPlanGenerationRunTerminalState(snapshot.status)) stop()
    }
    const read = async () => {
      const user = await this.auth.revalidateUser(request)
      if (user.id !== userId) throw new UnauthorizedException()
      if (stopped) return null
      return this.getRun.execute({ actorUserId: userId, generationRunId: runId })
    }
    const poll = async () => {
      try {
        const snapshot = await read()
        if (!stopped && snapshot) publish(snapshot)
      } catch (error: unknown) {
        const payload: PlanGenerationStreamError = {
          code:
            error instanceof UnauthorizedException
              ? 'UNAUTHENTICATED'
              : error instanceof PlanGenerationRunNotFoundError
                ? 'RESOURCE_NOT_FOUND'
                : 'STREAM_UNAVAILABLE',
        }
        write(`event: stream-error\ndata: ${JSON.stringify(payload)}\n\n`)
        stop()
      }
      // 串行查询，不因一次慢查询叠加下一轮；断开后的迟到结果不再发送。
      if (!stopped)
        timer = setTimeout(() => {
          void poll()
        }, PLAN_STREAM_INTERVAL_MS)
    }

    try {
      const initial = await read()
      if (stopped || !initial) return
      // 鉴权、归属、首次读取全部成功后才发送 200，之前仍可返回正常 HTTP 错误。
      response.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
      response.setHeader('Cache-Control', 'no-store, no-transform')
      response.setHeader('X-Accel-Buffering', 'no')
      response.flushHeaders()
      write(`retry: ${PLAN_STREAM_INTERVAL_MS}\n\n`)
      publish(initial)
      if (!stopped)
        timer = setTimeout(() => {
          void poll()
        }, PLAN_STREAM_INTERVAL_MS)
    } catch (error: unknown) {
      const alreadyStopped = stopped
      stop()
      if (alreadyStopped || response.headersSent) return
      if (error instanceof UnauthorizedException) throw error
      if (error instanceof PlanGenerationRunNotFoundError) {
        throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND', message: error.message })
      }
      throw new ServiceUnavailableException({
        code: 'STREAM_UNAVAILABLE',
        message: 'Subscription unavailable',
      })
    }
  }

  beforeApplicationShutdown() {
    this.shuttingDown = true
    for (const stop of this.connections.keys()) stop()
  }
}
