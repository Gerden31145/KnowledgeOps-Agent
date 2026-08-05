import { livenessResponseSchema, readinessResponseSchema } from '@knowledgeops/contracts'
import { describe, expect, it, vi } from 'vitest'

import type { DependencyProbe } from '../src/health/dependency-probe.js'
import { HealthService } from '../src/health/health.service.js'

function createProbe(result: 'up' | 'down'): DependencyProbe {
  return {
    check: vi.fn(async () => {
      if (result === 'down') {
        throw new Error('dependency unavailable')
      }
    }),
    close: vi.fn(async () => undefined),
  }
}

describe('HealthService', () => {
  it('keeps liveness independent from PostgreSQL and Redis', () => {
    const service = new HealthService({
      postgresql: createProbe('down'),
      redis: createProbe('down'),
    })

    const response = service.getLiveness()

    expect(response.status).toBe('alive')
    expect(livenessResponseSchema.safeParse(response).success).toBe(true)
  })

  it('reports not_ready when either required dependency is unavailable', async () => {
    const service = new HealthService({
      postgresql: createProbe('up'),
      redis: createProbe('down'),
    })

    const response = await service.getReadiness()

    expect(response).toMatchObject({
      status: 'not_ready',
      checks: {
        postgresql: { status: 'up' },
        redis: { status: 'down' },
      },
    })
    expect(readinessResponseSchema.safeParse(response).success).toBe(true)
  })

  it('closes both dependency clients during graceful shutdown', async () => {
    const postgresql = createProbe('up')
    const redis = createProbe('up')
    const service = new HealthService({ postgresql, redis })

    await service.onApplicationShutdown()

    expect(postgresql.close).toHaveBeenCalledOnce()
    expect(redis.close).toHaveBeenCalledOnce()
  })
})
