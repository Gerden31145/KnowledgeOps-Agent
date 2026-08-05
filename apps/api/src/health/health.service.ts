import {
  livenessResponseSchema,
  readinessResponseSchema,
  type DependencyHealth,
  type LivenessResponse,
  type ReadinessResponse,
} from '@knowledgeops/contracts'
import { Injectable, type OnApplicationShutdown } from '@nestjs/common'

import type { DependencyProbe, ReadinessProbes } from './dependency-probe.js'

@Injectable()
export class HealthService implements OnApplicationShutdown {
  constructor(private readonly probes: ReadinessProbes) {}

  getLiveness(): LivenessResponse {
    return livenessResponseSchema.parse({
      service: 'api',
      status: 'alive',
      timestamp: new Date().toISOString(),
      uptimeSeconds: process.uptime(),
    })
  }

  async getReadiness(): Promise<ReadinessResponse> {
    const [postgresql, redis] = await Promise.all([
      this.checkDependency(this.probes.postgresql),
      this.checkDependency(this.probes.redis),
    ])

    return readinessResponseSchema.parse({
      service: 'api',
      status: postgresql.status === 'up' && redis.status === 'up' ? 'ready' : 'not_ready',
      timestamp: new Date().toISOString(),
      checks: {
        postgresql,
        redis,
      },
    })
  }

  async onApplicationShutdown() {
    await Promise.allSettled([this.probes.postgresql.close(), this.probes.redis.close()])
  }

  private async checkDependency(probe: DependencyProbe): Promise<DependencyHealth> {
    const startedAt = performance.now()

    try {
      await probe.check()

      return {
        status: 'up',
        latencyMs: this.elapsedMilliseconds(startedAt),
      }
    } catch {
      return {
        status: 'down',
        latencyMs: this.elapsedMilliseconds(startedAt),
      }
    }
  }

  private elapsedMilliseconds(startedAt: number) {
    return Number((performance.now() - startedAt).toFixed(2))
  }
}
