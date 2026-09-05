import { type LivenessResponse, type ReadinessResponse } from '@knowledgeops/contracts'
import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common'

import { HealthService } from './health.service.js'

@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly healthService: HealthService) {}

  @Get('live')
  getLiveness(): LivenessResponse {
    return this.healthService.getLiveness()
  }

  @Get('ready')
  async getReadiness(): Promise<ReadinessResponse> {
    const readiness = await this.healthService.getReadiness()

    if (readiness.status === 'not_ready') {
      throw new ServiceUnavailableException(readiness)
    }

    return readiness
  }
}
