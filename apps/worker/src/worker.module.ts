import { Module } from '@nestjs/common'

import { ConfigModule } from './config/config.module.js'
import { DatabaseModule } from './database/database.module.js'
import { PlanGenerationJobProcessor } from './plan-generation/plan-generation-job-processor.js'
import { WorkerRuntimeService } from './worker-runtime.service.js'

@Module({
  imports: [ConfigModule, DatabaseModule],
  providers: [PlanGenerationJobProcessor, WorkerRuntimeService],
})
export class WorkerModule {}
