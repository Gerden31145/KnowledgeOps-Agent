import { SERVICE_NAMES } from '@knowledgeops/contracts'
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common'

import { WORKER_ENVIRONMENT } from './config/config.module.js'
import type { WorkerEnvironment } from './config/environment.js'
import { DatabaseService } from './database/database.service.js'
import { OutboxDispatchLoop } from './outbox/outbox-dispatch-loop.js'
import { OutboxDispatcher } from './outbox/outbox-dispatcher.js'
import { PlanGenerationJobProcessor } from './plan-generation/plan-generation-job-processor.js'
import { PlanGenerationRunRepository } from './plan-generation/plan-generation-run.repository.js'
import { PlanGenerationTimeoutSweepLoop } from './plan-generation/plan-generation-timeout-sweep-loop.js'
import { BullMqPlanGenerationQueue } from './queue/bullmq-plan-generation-queue.js'

@Injectable()
export class WorkerRuntimeService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WorkerRuntimeService.name)
  private dispatchLoop: OutboxDispatchLoop | undefined
  private queue: BullMqPlanGenerationQueue | undefined
  private timeoutSweepLoop: PlanGenerationTimeoutSweepLoop | undefined

  constructor(
    @Inject(WORKER_ENVIRONMENT) private readonly environment: WorkerEnvironment,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(PlanGenerationJobProcessor)
    private readonly planGenerationProcessor: PlanGenerationJobProcessor,
    @Inject(PlanGenerationRunRepository)
    private readonly planGenerationRunRepository: PlanGenerationRunRepository,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.queue = new BullMqPlanGenerationQueue({
      concurrency: this.environment.WORKER_CONCURRENCY,
      jobOptions: {
        attempts: this.environment.BULLMQ_JOB_ATTEMPTS,
        backoffDelayMs: this.environment.BULLMQ_JOB_BACKOFF_MS,
      },
      processor: this.planGenerationProcessor,
      redisUrl: this.environment.REDIS_URL,
    })

    try {
      this.queue.start()

      this.timeoutSweepLoop = new PlanGenerationTimeoutSweepLoop(
        this.planGenerationRunRepository,
        this.environment.PLAN_GENERATION_TIMEOUT_SWEEP_BATCH_SIZE,
        this.environment.PLAN_GENERATION_TIMEOUT_SWEEP_INTERVAL_MS,
      )
      await this.timeoutSweepLoop.start()

      const dispatcher = new OutboxDispatcher(this.database.client, this.queue, {
        baseDelayMs: this.environment.OUTBOX_RETRY_BASE_DELAY_MS,
        maxDelayMs: this.environment.OUTBOX_RETRY_MAX_DELAY_MS,
      })

      this.dispatchLoop = new OutboxDispatchLoop(
        dispatcher,
        this.environment.OUTBOX_BATCH_SIZE,
        this.environment.OUTBOX_POLL_INTERVAL_MS,
      )
      await this.dispatchLoop.start()

      this.logger.log({
        event: 'worker_runtime_started',
        concurrency: this.environment.WORKER_CONCURRENCY,
        service: SERVICE_NAMES[2],
      })
    } catch (error: unknown) {
      try {
        await this.timeoutSweepLoop?.stop()
        await this.queue.close()
      } finally {
        await this.database.close()
      }
      this.queue = undefined
      this.timeoutSweepLoop = undefined
      throw error
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.dispatchLoop?.stop()
    await this.timeoutSweepLoop?.stop()
    try {
      await this.queue?.close()
    } finally {
      await this.database.close()
    }
  }
}
