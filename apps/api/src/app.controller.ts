import { Controller, Get } from '@nestjs/common'
import { SERVICE_NAMES } from '@knowledgeops/contracts'

@Controller()
export class AppController {
  @Get()
  getServiceDescriptor() {
    return {
      service: SERVICE_NAMES[1],
      status: 'ok',
      message: 'KnowledgeOps API skeleton is running',
    } as const
  }
}
