import { LangChainPlanGenerator, type PlanGenerationPort } from '@knowledgeops/agent-core'
import { Module, type Provider } from '@nestjs/common'

import { ConfigModule, WORKER_ENVIRONMENT } from './config/config.module.js'
import type { WorkerEnvironment } from './config/environment.js'
import { DatabaseModule } from './database/database.module.js'
import { DatabaseService } from './database/database.service.js'
import { BoundCommitEvidenceReader } from './github/read-bound-commit-evidence.js'
import { GitHubEvidenceJobProcessor } from './github/github-evidence-job-processor.js'
import {
  FinalizePlanGenerationRun,
  PLAN_GENERATION_SUCCESS_FINALIZER,
  type PlanGenerationSuccessFinalizer,
} from './plan-generation/finalize-plan-generation-run.js'
import { PlanGenerationJobProcessor } from './plan-generation/plan-generation-job-processor.js'
import { PlanGenerationRunRepository } from './plan-generation/plan-generation-run.repository.js'
import { WorkerRuntimeService } from './worker-runtime.service.js'

export const PLAN_GENERATION_PORT = Symbol('PLAN_GENERATION_PORT')

const planGenerationRunRepositoryProvider: Provider<PlanGenerationRunRepository> = {
  provide: PlanGenerationRunRepository,
  inject: [DatabaseService],
  useFactory: (database: DatabaseService) => new PlanGenerationRunRepository(database.client),
}

const planGenerationPortProvider: Provider<PlanGenerationPort> = {
  provide: PLAN_GENERATION_PORT,
  inject: [WORKER_ENVIRONMENT],
  useFactory: (environment: WorkerEnvironment) =>
    new LangChainPlanGenerator({
      structuredOutputMethod: environment.PLAN_GENERATION_OUTPUT_METHOD,
      ...(environment.OPENAI_API_KEY ? { apiKey: environment.OPENAI_API_KEY } : {}),
      ...(environment.OPENAI_BASE_URL ? { baseUrl: environment.OPENAI_BASE_URL } : {}),
    }),
}

const planGenerationFinalizerProvider: Provider<PlanGenerationSuccessFinalizer> = {
  provide: PLAN_GENERATION_SUCCESS_FINALIZER,
  inject: [DatabaseService],
  useFactory: (database: DatabaseService) => new FinalizePlanGenerationRun(database.client),
}

const planGenerationJobProcessorProvider: Provider<PlanGenerationJobProcessor> = {
  provide: PlanGenerationJobProcessor,
  inject: [PlanGenerationRunRepository, PLAN_GENERATION_PORT, PLAN_GENERATION_SUCCESS_FINALIZER],
  useFactory: (
    repository: PlanGenerationRunRepository,
    port: PlanGenerationPort,
    finalizer: PlanGenerationSuccessFinalizer,
  ) => new PlanGenerationJobProcessor(repository, port, finalizer),
}

const gitHubEvidenceProcessorProvider: Provider<GitHubEvidenceJobProcessor> = {
  provide: GitHubEvidenceJobProcessor,
  inject: [DatabaseService, WORKER_ENVIRONMENT],
  useFactory: (database: DatabaseService, environment: WorkerEnvironment) =>
    new GitHubEvidenceJobProcessor(
      database.client,
      new BoundCommitEvidenceReader(database.client, environment),
    ),
}

@Module({
  imports: [ConfigModule, DatabaseModule],
  providers: [
    planGenerationRunRepositoryProvider,
    planGenerationPortProvider,
    planGenerationFinalizerProvider,
    planGenerationJobProcessorProvider,
    gitHubEvidenceProcessorProvider,
    WorkerRuntimeService,
  ],
})
export class WorkerModule {}
