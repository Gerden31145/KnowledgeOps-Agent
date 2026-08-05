import { Module, type Provider } from '@nestjs/common'

import { API_ENVIRONMENT } from '../config/config.module.js'
import type { ApiEnvironment } from '../config/environment.js'
import { HealthController } from './health.controller.js'
import { HealthService } from './health.service.js'
import { PostgresReadinessProbe } from './postgres-readiness.probe.js'
import { RedisReadinessProbe } from './redis-readiness.probe.js'

const healthServiceProvider: Provider<HealthService> = {
  provide: HealthService,
  inject: [API_ENVIRONMENT],
  useFactory: (environment: ApiEnvironment) =>
    new HealthService({
      postgresql: new PostgresReadinessProbe(environment.DATABASE_URL),
      redis: new RedisReadinessProbe(environment.REDIS_URL),
    }),
}

@Module({
  controllers: [HealthController],
  providers: [healthServiceProvider],
})
export class HealthModule {}
