import { describe, it, beforeEach, vi, expect } from 'vitest'
import { Test, type TestingModule } from '@nestjs/testing'
import { HealthController } from '../src/health/health.controller.js'
import { HealthService } from '../src/health/health.service.js'
import { type LivenessResponse, type ReadinessResponse } from '@knowledgeops/contracts'
import { ServiceUnavailableException } from '@nestjs/common'

describe('HealthController with Nest TestingModule', () => {
  const FIXED_TIMESTAMP = '2026-08-05T00:00:00.000Z'

  describe('Health Controller', () => {
    let controller: HealthController

    const healthMockService = {
      getLiveness: vi.fn(),
      getReadiness: vi.fn(),
    }

    beforeEach(async () => {
      vi.resetAllMocks() // 重置记录

      const moduleRef: TestingModule = await Test.createTestingModule({
        controllers: [HealthController],

        providers: [
          {
            provide: HealthService,
            useValue: healthMockService,
          },
        ],
      }).compile()

      controller = moduleRef.get(HealthController)
    })

    it('成功创建healthController', () => {
      expect(controller).toBeDefined()
    })

    describe('getLiveness', () => {
      it('应该返回 HealthService 的存活检查结果', () => {
        const liveness: LivenessResponse = {
          service: 'api',
          status: 'alive',
          timestamp: FIXED_TIMESTAMP,
          uptimeSeconds: 100,
        }

        healthMockService.getLiveness.mockReturnValue(liveness)

        const result = controller.getLiveness()

        expect(result).toEqual(liveness)
        expect(healthMockService.getLiveness).toHaveBeenCalledOnce()
      })
    })

    describe('getReadiness', () => {
      it('当服务已准备好时，应该返回 readiness 结果', async () => {
        const readiness: ReadinessResponse = {
          service: 'api',
          status: 'ready',
          timestamp: FIXED_TIMESTAMP,
          checks: {
            postgresql: {
              status: 'up',
              latencyMs: 100,
            },
            redis: {
              status: 'up',
              latencyMs: 100,
            },
          },
        }

        healthMockService.getReadiness.mockResolvedValue(readiness)

        const result = await controller.getReadiness()

        expect(result).toEqual(readiness)
        expect(healthMockService.getReadiness).toHaveBeenCalledOnce()
      })

      it('当服务器未准备好时，抛出503错误', async () => {
        const readiness: ReadinessResponse = {
          service: 'api',
          status: 'not_ready',
          timestamp: FIXED_TIMESTAMP,
          checks: {
            postgresql: {
              status: 'down',
              latencyMs: 100,
            },
            redis: {
              status: 'up',
              latencyMs: 100,
            },
          },
        }

        healthMockService.getReadiness.mockResolvedValue(readiness)

        let thrownError
        try {
          await controller.getReadiness()
        } catch (err) {
          thrownError = err
        }

        expect(thrownError).toBeInstanceOf(ServiceUnavailableException)

        const exception = thrownError as ServiceUnavailableException
        expect(exception.getStatus()).toBe(503)
        expect(exception.getResponse()).toEqual(readiness)

        expect(healthMockService.getReadiness).toHaveBeenCalledOnce()
      })
    })
  })
})
