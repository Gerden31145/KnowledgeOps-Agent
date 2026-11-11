import { Module, type Provider } from '@nestjs/common'

import { API_ENVIRONMENT } from '../config/config.module.js'
import type { ApiEnvironment } from '../config/environment.js'
import { DatabaseService } from '../database/database.service.js'
import { PlanLifecycleController } from './plan-lifecycle.controller.js'
import { PlanLifecycleRepository } from './plan-lifecycle.repository.js'
import { PlanLifecycleService } from './plan-lifecycle.service.js'
import { PlanQueryController } from './plan-query.controller.js'
import { PlanQueryService } from './plan-query.service.js'
import { PlanRepository } from './plan.repository.js'

const lifecycleRepositoryProvider: Provider<PlanLifecycleRepository> = {
  provide: PlanLifecycleRepository,
  inject: [DatabaseService, API_ENVIRONMENT],
  useFactory: (database: DatabaseService, environment: ApiEnvironment) =>
    new PlanLifecycleRepository(
      database.client,
      () => new Date(),
      environment.PLAN_GENERATION_TIMEOUT_MS,
    ),
}

const lifecycleServiceProvider: Provider<PlanLifecycleService> = {
  provide: PlanLifecycleService,
  inject: [PlanLifecycleRepository],
  useFactory: (repository: PlanLifecycleRepository) => new PlanLifecycleService(repository),
}

const planRepositoryProvider: Provider<PlanRepository> = {
  provide: PlanRepository,
  inject: [DatabaseService],
  useFactory: (database: DatabaseService) => new PlanRepository(database.client),
}

const planQueryServiceProvider: Provider<PlanQueryService> = {
  provide: PlanQueryService,
  inject: [PlanRepository],
  useFactory: (repository: PlanRepository) => new PlanQueryService(repository),
}

@Module({
  controllers: [PlanLifecycleController, PlanQueryController],
  providers: [
    lifecycleRepositoryProvider,
    lifecycleServiceProvider,
    planRepositoryProvider,
    planQueryServiceProvider,
  ],
})
export class PlansModule {}
