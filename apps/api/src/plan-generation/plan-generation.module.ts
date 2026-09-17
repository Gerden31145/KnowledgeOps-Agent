import { Module, type Provider } from '@nestjs/common'

import { API_ENVIRONMENT } from '../config/config.module.js'
import type { ApiEnvironment } from '../config/environment.js'
import { DatabaseService } from '../database/database.service.js'
import { AuthService } from '../identity/auth.service.js'
import { AcceptPlanGenerationService } from './accept-plan-generation.service.js'
import { GetPlanGenerationRunService } from './get-plan-generation-run.service.js'
import { PlanGenerationController } from './plan-generation.controller.js'
import { PlanGenerationModelController } from './plan-generation-model.controller.js'
import { PlanGenerationRunController } from './plan-generation-run.controller.js'
import { PlanGenerationModelCatalog } from './plan-generation-model-catalog.js'
import { PlanGenerationRepository } from './plan-generation.repository.js'
import { PlanGenerationStreamService } from './plan-generation-stream.service.js'

const modelCatalogProvider: Provider<PlanGenerationModelCatalog> = {
  provide: PlanGenerationModelCatalog,
  inject: [API_ENVIRONMENT],
  useFactory: (environment: ApiEnvironment) =>
    new PlanGenerationModelCatalog(
      environment.PLAN_GENERATION_MODELS_JSON,
      environment.PLAN_GENERATION_PROVIDER,
      environment.PLAN_GENERATION_PROMPT_VERSION,
      environment.PLAN_GENERATION_OUTPUT_SCHEMA_VERSION,
    ),
}

const repositoryProvider: Provider<PlanGenerationRepository> = {
  provide: PlanGenerationRepository,
  inject: [DatabaseService],
  useFactory: (database: DatabaseService) => new PlanGenerationRepository(database.client),
}

const acceptPlanGenerationProvider: Provider<AcceptPlanGenerationService> = {
  provide: AcceptPlanGenerationService,
  inject: [PlanGenerationRepository, PlanGenerationModelCatalog, API_ENVIRONMENT],
  useFactory: (
    repository: PlanGenerationRepository,
    modelCatalog: PlanGenerationModelCatalog,
    environment: ApiEnvironment,
  ) =>
    new AcceptPlanGenerationService(
      repository,
      modelCatalog,
      environment.PLAN_GENERATION_TIMEOUT_MS,
    ),
}

const getPlanGenerationRunProvider: Provider<GetPlanGenerationRunService> = {
  provide: GetPlanGenerationRunService,
  inject: [PlanGenerationRepository],
  useFactory: (repository: PlanGenerationRepository) => new GetPlanGenerationRunService(repository),
}

@Module({
  controllers: [
    PlanGenerationController,
    PlanGenerationModelController,
    PlanGenerationRunController,
  ],
  providers: [
    modelCatalogProvider,
    repositoryProvider,
    acceptPlanGenerationProvider,
    getPlanGenerationRunProvider,
    {
      provide: PlanGenerationStreamService,
      inject: [GetPlanGenerationRunService, AuthService],
      useFactory: (getRun: GetPlanGenerationRunService, auth: AuthService) =>
        new PlanGenerationStreamService(getRun, auth),
    },
  ],
})
export class PlanGenerationModule {}
