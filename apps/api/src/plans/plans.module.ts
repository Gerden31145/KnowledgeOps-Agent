import { Module, type Provider } from '@nestjs/common'

import { DatabaseService } from '../database/database.service.js'
import { PlanLifecycleController } from './plan-lifecycle.controller.js'
import { PlanLifecycleRepository } from './plan-lifecycle.repository.js'
import { PlanLifecycleService } from './plan-lifecycle.service.js'

const lifecycleRepositoryProvider: Provider<PlanLifecycleRepository> = {
  provide: PlanLifecycleRepository,
  inject: [DatabaseService],
  useFactory: (database: DatabaseService) => new PlanLifecycleRepository(database.client),
}

const lifecycleServiceProvider: Provider<PlanLifecycleService> = {
  provide: PlanLifecycleService,
  inject: [PlanLifecycleRepository],
  useFactory: (repository: PlanLifecycleRepository) => new PlanLifecycleService(repository),
}

@Module({
  controllers: [PlanLifecycleController],
  providers: [lifecycleRepositoryProvider, lifecycleServiceProvider],
})
export class PlansModule {}
