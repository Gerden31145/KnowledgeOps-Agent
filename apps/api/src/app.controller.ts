import { SERVICE_NAMES, type ServiceDescriptor } from '@knowledgeops/contracts'
import { Controller, Get } from '@nestjs/common'
import { PublicRoute } from './identity/auth.guard.js'

@PublicRoute()
@Controller()
export class AppController {
  @Get()
  getServiceDescriptor(): ServiceDescriptor {
    return {
      service: SERVICE_NAMES[1],
      status: 'ok',
      message: 'KnowledgeOps API skeleton is running',
    }
  }
}
