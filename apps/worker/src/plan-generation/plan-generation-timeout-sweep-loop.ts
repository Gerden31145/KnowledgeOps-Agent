import { Logger } from '@nestjs/common'

import { toError } from '../outbox/outbox-dispatch-error.js'
import {
  PlanGenerationRunRepository,
  sanitizePlanGenerationErrorMessage,
} from './plan-generation-run.repository.js'

export class PlanGenerationTimeoutSweepLoop {
  private readonly logger = new Logger(PlanGenerationTimeoutSweepLoop.name)
  private inFlight: Promise<void> | undefined
  private timer: NodeJS.Timeout | undefined

  constructor(
    private readonly repository: PlanGenerationRunRepository,
    private readonly batchSize: number,
    private readonly intervalMs: number,
  ) {}

  async start(): Promise<void> {
    if (this.timer) {
      return
    }

    await this.trigger()
    this.timer = setInterval(() => void this.trigger(), this.intervalMs)
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }

    await this.inFlight
  }

  private async trigger(): Promise<void> {
    if (this.inFlight) {
      return this.inFlight
    }

    this.inFlight = this.runCycle().finally(() => {
      this.inFlight = undefined
    })

    return this.inFlight
  }

  private async runCycle(): Promise<void> {
    try {
      const timedOutRunIds = await this.repository.timeoutExpired(this.batchSize, new Date())

      if (timedOutRunIds.length > 0) {
        this.logger.warn({
          event: 'plan_generation_timeout_sweep_completed',
          generationRunIds: timedOutRunIds,
          timedOutCount: timedOutRunIds.length,
        })
      }
    } catch (error: unknown) {
      const normalized = toError(error)
      this.logger.error({
        event: 'plan_generation_timeout_sweep_failed',
        errorMessage: sanitizePlanGenerationErrorMessage(normalized.message),
        errorName: normalized.name,
      })
    }
  }
}
