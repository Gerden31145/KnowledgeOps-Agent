import 'reflect-metadata'

import { StructuredLogger } from '@knowledgeops/observability'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'

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
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger, rawBody: true })
  // 保留原 100kb JSON 上限，拒绝压缩体，确保验签拿到发送方的原始字节。
  app.useBodyParser('json', { limit: '100kb', inflate: false })

  // 让 Nest 在收到 SIGTERM、SIGINT 等关闭信号时，调用 Provider 的生命周期方法
  app.enableShutdownHooks()
  app.enableCors({
    credentials: true,
    origin: environment.WEB_ORIGIN,
  })
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
