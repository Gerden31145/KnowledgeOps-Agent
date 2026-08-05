import 'reflect-metadata'

import { StructuredLogger } from '@knowledgeops/observability'
import { NestFactory } from '@nestjs/core'

import { AppModule } from './app.module.js'
import { readApiEnvironment } from './config/environment.js'
import { createHttpRequestLogger } from './observability/http-request-logger.js'

const bootstrapLogger = new StructuredLogger({ service: 'api' })

async function bootstrap() {
  const environment = readApiEnvironment()
  const logger = new StructuredLogger({
    service: 'api',
    minimumLevel: environment.LOG_LEVEL,
  })
  const app = await NestFactory.create(AppModule, { logger })

  // 让 Nest 在收到 SIGTERM、SIGINT 等关闭信号时，调用 Provider 的生命周期方法
  app.enableShutdownHooks()
  app.use(createHttpRequestLogger(logger))
  await app.listen(environment.API_PORT, environment.API_HOST)

  logger.log(
    {
      event: 'service.started',
      host: environment.API_HOST,
      port: environment.API_PORT,
    },
    'Bootstrap',
  )
}

void bootstrap().catch((error: unknown) => {
  bootstrapLogger.error(error, 'ApiBootstrap')
  process.exitCode = 1
})
