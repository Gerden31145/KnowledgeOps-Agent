import { NestFactory } from '@nestjs/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readWorkerEnvironment } from '../src/config/environment.js'

import { DatabaseService } from '../src/database/database.service.js'
import { GitHubEvidenceJobProcessor } from '../src/github/github-evidence-job-processor.js'
import { GitHubEvidenceReconciler } from '../src/github/github-evidence-reconciler.js'
import { OutboxDispatcher } from '../src/outbox/outbox-dispatcher.js'
import { PlanGenerationJobProcessor } from '../src/plan-generation/plan-generation-job-processor.js'
import { PlanGenerationRunRepository } from '../src/plan-generation/plan-generation-run.repository.js'
import { WorkerModule } from '../src/worker.module.js'
import { WorkerRuntimeService } from '../src/worker-runtime.service.js'
import { NoteVerificationJobProcessor } from '../src/verification/note-verification-job-processor.js'
import { NoteVerificationRunRepository } from '../src/verification/note-verification-run.repository.js'

const queue = vi.hoisted(() => ({
  constructed: vi.fn(),
  start: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
}))

const evidenceQueue = vi.hoisted(() => ({
  constructed: vi.fn(),
  start: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
}))

const noteQueue = vi.hoisted(() => ({
  constructed: vi.fn(),
  start: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
  isFailed: vi.fn().mockResolvedValue(false),
}))
vi.mock('../src/queue/bullmq-note-verification-queue.js', () => ({
  BullMqNoteVerificationQueue: class {
    constructor(options: unknown) {
      noteQueue.constructed(options)
    }
    start = noteQueue.start
    close = noteQueue.close
    isFailed = noteQueue.isFailed
  },
}))

vi.mock('../src/queue/bullmq-github-evidence-queue.js', () => ({
  BullMqGitHubEvidenceQueue: class {
    constructor(options: unknown) {
      evidenceQueue.constructed(options)
    }
    start = evidenceQueue.start
    close = evidenceQueue.close
  },
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
  beforeEach(() => {
    vi.clearAllMocks()
  })
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
    const reconcile = vi.spyOn(GitHubEvidenceReconciler.prototype, 'reconcile').mockResolvedValue(0)
    vi.spyOn(NoteVerificationRunRepository.prototype, 'reconcile').mockResolvedValue(0)
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
      expect(evidenceQueue.constructed).toHaveBeenCalledWith(
        expect.objectContaining({ processor: expect.any(GitHubEvidenceJobProcessor) }),
      )
      expect(evidenceQueue.start).toHaveBeenCalledOnce()
      expect(noteQueue.start).not.toHaveBeenCalled()
      expect(sweep).toHaveBeenCalledWith(expect.any(Number), expect.any(Date))
      expect(dispatch).toHaveBeenCalledWith(expect.any(Number))
      expect(reconcile).toHaveBeenCalledWith(expect.any(Number))
    } finally {
      await app?.close()
      if (metadata !== undefined) {
        Reflect.defineMetadata('design:paramtypes', metadata, WorkerRuntimeService)
      }
      vi.restoreAllMocks()
    }

    expect(queue.close).toHaveBeenCalledOnce()
    expect(evidenceQueue.close).toHaveBeenCalledOnce()
    expect(closeDatabase).toHaveBeenCalledOnce()
  })

  it('closes both queues and the database when the evidence consumer cannot start', async () => {
    const close = vi.fn().mockResolvedValue(undefined)
    evidenceQueue.start.mockImplementationOnce(() => {
      throw new Error('fixture-start-failure')
    })
    const runtime = new WorkerRuntimeService(
      readWorkerEnvironment({}),
      { close } as unknown as DatabaseService,
      {} as PlanGenerationJobProcessor,
      {} as PlanGenerationRunRepository,
      {} as GitHubEvidenceJobProcessor,
      {} as NoteVerificationJobProcessor,
      {} as NoteVerificationRunRepository,
    )
    await expect(runtime.onApplicationBootstrap()).rejects.toThrow('fixture-start-failure')
    expect(queue.close).toHaveBeenCalledOnce()
    expect(evidenceQueue.close).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it('wires the configured note consumer and reconciles even when GitHub reconciliation fails', async () => {
    const close = vi.fn().mockResolvedValue(undefined)
    const reconcile = vi.fn().mockResolvedValue(0)
    vi.spyOn(OutboxDispatcher.prototype, 'dispatchAvailable').mockResolvedValue({
      inspected: 0,
      deadLettered: 0,
      dispatched: 0,
      retryScheduled: 0,
    })
    vi.spyOn(GitHubEvidenceReconciler.prototype, 'reconcile').mockRejectedValue(
      new Error('fixture-unavailable'),
    )
    const noteProcessor = {} as NoteVerificationJobProcessor
    const runtime = new WorkerRuntimeService(
      readWorkerEnvironment({
        OPENAI_API_KEY: 'fixture',
        NOTE_VERIFICATION_MODEL_JSON: JSON.stringify({
          catalogId: 'fixture',
          modelName: 'fixture',
          currency: 'CNY',
          inputMicrounitsPerMillionTokens: 1,
          outputMicrounitsPerMillionTokens: 1,
        }),
      }),
      { close } as unknown as DatabaseService,
      {} as PlanGenerationJobProcessor,
      { timeoutExpired: vi.fn().mockResolvedValue([]) } as unknown as PlanGenerationRunRepository,
      {} as GitHubEvidenceJobProcessor,
      noteProcessor,
      { reconcile } as unknown as NoteVerificationRunRepository,
    )
    try {
      await runtime.onApplicationBootstrap()
      expect(noteQueue.constructed).toHaveBeenCalledWith(
        expect.objectContaining({ processor: noteProcessor }),
      )
      expect(noteQueue.start).toHaveBeenCalledOnce()
      expect(reconcile).toHaveBeenCalledWith(expect.any(Number), expect.any(Function))
    } finally {
      await runtime.onApplicationShutdown()
      vi.restoreAllMocks()
    }
    expect(noteQueue.close).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })
})
