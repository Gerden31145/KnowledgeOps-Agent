import 'reflect-metadata'

import { StructuredLogger } from '@knowledgeops/observability'
import { NestFactory } from '@nestjs/core'

import { readWorkerEnvironment } from './config/environment.js'
import { WorkerModule } from './worker.module.js'

const bootstrapLogger = new StructuredLogger({ service: 'worker' })

async function bootstrap() {
  const environment = readWorkerEnvironment()
  const logger = new StructuredLogger({
    service: 'worker',
    minimumLevel: environment.LOG_LEVEL,
  })
  const application = await NestFactory.createApplicationContext(WorkerModule, { logger })
  application.enableShutdownHooks()
}

void bootstrap().catch((error: unknown) => {
  bootstrapLogger.error(error, 'WorkerBootstrap')
  process.exitCode = 1
})
