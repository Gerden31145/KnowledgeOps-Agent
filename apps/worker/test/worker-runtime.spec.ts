import { NestFactory } from '@nestjs/core'
import { describe, expect, it, vi } from 'vitest'

import { DatabaseService } from '../src/database/database.service.js'
import { OutboxDispatcher } from '../src/outbox/outbox-dispatcher.js'
import { PlanGenerationJobProcessor } from '../src/plan-generation/plan-generation-job-processor.js'
import { PlanGenerationRunRepository } from '../src/plan-generation/plan-generation-run.repository.js'
import { WorkerModule } from '../src/worker.module.js'
import { WorkerRuntimeService } from '../src/worker-runtime.service.js'

const queue = vi.hoisted(() => ({
  constructed: vi.fn(),
  start: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../src/queue/bullmq-plan-generation-queue.js', () => ({
  BullMqPlanGenerationQueue: class {
    constructor(options: unknown) {
      queue.constructed(options)
    }

    start = queue.start
    close = queue.close
  },
}))

describe('Worker runtime dependency injection', () => {
  it('boots the real module, starts both loops and closes resources without emitted type metadata', async () => {
    // Vitest may emit metadata that tsx does not. Reproduce the dev-runner boundary explicitly.
    const metadata = Reflect.getOwnMetadata('design:paramtypes', WorkerRuntimeService)
    Reflect.deleteMetadata('design:paramtypes', WorkerRuntimeService)
    const sweep = vi
      .spyOn(PlanGenerationRunRepository.prototype, 'timeoutExpired')
      .mockResolvedValue([])
    const dispatch = vi.spyOn(OutboxDispatcher.prototype, 'dispatchAvailable').mockResolvedValue({
      deadLettered: 0,
      dispatched: 0,
      inspected: 0,
      retryScheduled: 0,
    })
    const closeDatabase = vi.spyOn(DatabaseService.prototype, 'close')
    let app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>> | undefined

    try {
      app = await NestFactory.createApplicationContext(WorkerModule, {
        abortOnError: false,
        logger: false,
      })

      expect(queue.constructed).toHaveBeenCalledWith(
        expect.objectContaining({ processor: expect.any(PlanGenerationJobProcessor) }),
      )
      expect(queue.start).toHaveBeenCalledOnce()
      expect(sweep).toHaveBeenCalledWith(expect.any(Number), expect.any(Date))
      expect(dispatch).toHaveBeenCalledWith(expect.any(Number))
    } finally {
      await app?.close()
      if (metadata !== undefined) {
        Reflect.defineMetadata('design:paramtypes', metadata, WorkerRuntimeService)
      }
      vi.restoreAllMocks()
    }

    expect(queue.close).toHaveBeenCalledOnce()
    expect(closeDatabase).toHaveBeenCalledOnce()
  })
})
