import { Logger } from '@nestjs/common'

import { sanitizeDispatchErrorMessage, toError } from './outbox-dispatch-error.js'
import { OutboxDispatcher } from './outbox-dispatcher.js'

export class OutboxDispatchLoop {
  private readonly logger = new Logger(OutboxDispatchLoop.name)
  private inFlight: Promise<void> | undefined
  private timer: NodeJS.Timeout | undefined

  constructor(
    private readonly dispatcher: OutboxDispatcher,
    private readonly batchSize: number,
    private readonly pollIntervalMs: number,
    private readonly reconcileEvidence?: () => Promise<number>,
  ) {}

  async start(): Promise<void> {
    if (this.timer) {
      return
    }

    await this.trigger()
    this.timer = setInterval(() => void this.trigger(), this.pollIntervalMs)
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
      const summary = await this.dispatcher.dispatchAvailable(this.batchSize)

      if (summary.inspected > 0) {
        this.logger.log({
          event: 'outbox_dispatch_cycle_completed',
          ...summary,
        })
      }
    } catch (error: unknown) {
      const normalized = toError(error)
      this.logger.error({
        event: 'outbox_dispatch_cycle_failed',
        errorMessage: sanitizeDispatchErrorMessage(normalized.message),
        errorName: normalized.name,
      })
    } finally {
      // 复用同一轮询和停机等待；不依赖瞬时 failed 事件，也不新增一个定时器。
      try {
        const updated = await this.reconcileEvidence?.()
        if (updated) this.logger.log({ event: 'github_evidence_reconciled', updated })
      } catch {
        this.logger.warn({ event: 'github_evidence_reconcile_unavailable' })
      }
    }
  }
}
