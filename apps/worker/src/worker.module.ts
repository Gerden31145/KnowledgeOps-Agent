import {
  LangChainPlanGenerator,
  LangChainNoteVerifier,
  LangChainFollowUpGenerator,
  LangChainAnswerVerifier,
  type PlanGenerationPort,
} from '@knowledgeops/agent-core'
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
import { NoteVerificationRunRepository } from './verification/note-verification-run.repository.js'
import {
  NoteVerificationExecutionRepository,
  VerificationExecutionRepository,
} from './verification/note-verification-execution.repository.js'
import { NoteVerificationJobProcessor } from './verification/note-verification-job-processor.js'
import { AnswerVerificationRunRepository } from './verification/answer-verification-run.repository.js'
import { AnswerVerificationJobProcessor } from './verification/answer-verification-job-processor.js'
import { answerExecutionResultSchema } from './verification/execute-persisted-answer-verification.js'

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

const noteRunRepositoryProvider: Provider<NoteVerificationRunRepository> = {
  provide: NoteVerificationRunRepository,
  inject: [DatabaseService, WORKER_ENVIRONMENT],
  useFactory: (database: DatabaseService, environment: WorkerEnvironment) =>
    new NoteVerificationRunRepository(database.client, environment),
}
const noteProcessorProvider: Provider<NoteVerificationJobProcessor> = {
  provide: NoteVerificationJobProcessor,
  inject: [DatabaseService, WORKER_ENVIRONMENT, NoteVerificationRunRepository],
  useFactory: (
    database: DatabaseService,
    environment: WorkerEnvironment,
    runs: NoteVerificationRunRepository,
  ) =>
    new NoteVerificationJobProcessor(
      runs,
      new NoteVerificationExecutionRepository(database.client),
      new LangChainNoteVerifier({
        structuredOutputMethod: environment.PLAN_GENERATION_OUTPUT_METHOD,
        ...(environment.OPENAI_API_KEY ? { apiKey: environment.OPENAI_API_KEY } : {}),
        ...(environment.OPENAI_BASE_URL ? { baseUrl: environment.OPENAI_BASE_URL } : {}),
      }),
      new LangChainFollowUpGenerator({
        structuredOutputMethod: environment.PLAN_GENERATION_OUTPUT_METHOD,
        ...(environment.OPENAI_API_KEY ? { apiKey: environment.OPENAI_API_KEY } : {}),
        ...(environment.OPENAI_BASE_URL ? { baseUrl: environment.OPENAI_BASE_URL } : {}),
      }),
    ),
}

const answerRunRepositoryProvider: Provider<AnswerVerificationRunRepository> = {
  provide: AnswerVerificationRunRepository,
  inject: [DatabaseService, WORKER_ENVIRONMENT],
  useFactory: (database: DatabaseService, environment: WorkerEnvironment) =>
    new AnswerVerificationRunRepository(database.client, environment),
}
const answerProcessorProvider: Provider<AnswerVerificationJobProcessor> = {
  provide: AnswerVerificationJobProcessor,
  inject: [DatabaseService, WORKER_ENVIRONMENT, AnswerVerificationRunRepository],
  useFactory: (
    database: DatabaseService,
    environment: WorkerEnvironment,
    runs: AnswerVerificationRunRepository,
  ) =>
    new AnswerVerificationJobProcessor(
      runs,
      new VerificationExecutionRepository(
        database.client,
        'ANSWER_VERIFICATION',
        answerExecutionResultSchema,
      ),
      new LangChainAnswerVerifier({
        structuredOutputMethod: environment.PLAN_GENERATION_OUTPUT_METHOD,
        ...(environment.OPENAI_API_KEY ? { apiKey: environment.OPENAI_API_KEY } : {}),
        ...(environment.OPENAI_BASE_URL ? { baseUrl: environment.OPENAI_BASE_URL } : {}),
      }),
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
    noteRunRepositoryProvider,
    noteProcessorProvider,
    answerRunRepositoryProvider,
    answerProcessorProvider,
    WorkerRuntimeService,
  ],
})
export class WorkerModule {}
