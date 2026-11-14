import { NestFactory } from '@nestjs/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readWorkerEnvironment } from '../src/config/environment.js'

import { DatabaseService } from '../src/database/database.service.js'
import { CourseGenerationJobProcessor } from '../src/course-generation/course-generation-job-processor.js'
import { CourseGenerationRunRepository } from '../src/course-generation/course-generation-run.repository.js'
import { CourseQuestionExecutionRepository } from '../src/course-question/course-question-execution.repository.js'
import { CourseQuestionJobProcessor } from '../src/course-question/course-question-job-processor.js'
import { GitHubEvidenceJobProcessor } from '../src/github/github-evidence-job-processor.js'
import { GitHubEvidenceReconciler } from '../src/github/github-evidence-reconciler.js'
import { OutboxDispatcher } from '../src/outbox/outbox-dispatcher.js'
import { PlanGenerationJobProcessor } from '../src/plan-generation/plan-generation-job-processor.js'
import { PlanGenerationRunRepository } from '../src/plan-generation/plan-generation-run.repository.js'
import { WorkerModule } from '../src/worker.module.js'
import { WorkerRuntimeService } from '../src/worker-runtime.service.js'
import { NoteVerificationJobProcessor } from '../src/verification/note-verification-job-processor.js'
import { NoteVerificationRunRepository } from '../src/verification/note-verification-run.repository.js'

import { AnswerVerificationJobProcessor } from '../src/verification/answer-verification-job-processor.js'
import { AnswerVerificationRunRepository } from '../src/verification/answer-verification-run.repository.js'

const answerQueue = vi.hoisted(() => ({
  constructed: vi.fn(),
  start: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
  isFailed: vi.fn().mockResolvedValue(false),
}))
vi.mock('../src/queue/bullmq-answer-verification-queue.js', () => ({
  BullMqAnswerVerificationQueue: class {
    constructor(options: unknown) {
      answerQueue.constructed(options)
    }
    start = answerQueue.start
    close = answerQueue.close
    isFailed = answerQueue.isFailed
  },
}))

const queue = vi.hoisted(() => ({
  constructed: vi.fn(),
  start: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
}))

const courseQueue = vi.hoisted(() => ({
  constructed: vi.fn(),
  start: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../src/queue/bullmq-course-generation-queue.js', () => ({
  BullMqCourseGenerationQueue: class {
    constructor(options: unknown) {
      courseQueue.constructed(options)
    }
    start = courseQueue.start
    close = courseQueue.close
  },
}))

const questionQueue = vi.hoisted(() => ({
  constructed: vi.fn(),
  start: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../src/queue/bullmq-course-question-queue.js', () => ({
  BullMqCourseQuestionQueue: class {
    constructor(options: unknown) {
      questionQueue.constructed(options)
    }
    start = questionQueue.start
    close = questionQueue.close
  },
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
    vi.spyOn(CourseGenerationRunRepository.prototype, 'timeoutExpired').mockResolvedValue([])
    vi.spyOn(CourseQuestionExecutionRepository.prototype, 'timeoutExpired').mockResolvedValue([])
    const dispatch = vi.spyOn(OutboxDispatcher.prototype, 'dispatchAvailable').mockResolvedValue({
      deadLettered: 0,
      dispatched: 0,
      inspected: 0,
      retryScheduled: 0,
    })
    const closeDatabase = vi.spyOn(DatabaseService.prototype, 'close')
    const reconcile = vi.spyOn(GitHubEvidenceReconciler.prototype, 'reconcile').mockResolvedValue(0)
    vi.spyOn(NoteVerificationRunRepository.prototype, 'reconcile').mockResolvedValue(0)
    vi.spyOn(AnswerVerificationRunRepository.prototype, 'reconcile').mockResolvedValue(0)
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
      expect(questionQueue.constructed).toHaveBeenCalledWith(
        expect.objectContaining({ processor: expect.any(CourseQuestionJobProcessor) }),
      )
      expect(questionQueue.start).toHaveBeenCalledOnce()
      expect(evidenceQueue.constructed).toHaveBeenCalledWith(
        expect.objectContaining({ processor: expect.any(GitHubEvidenceJobProcessor) }),
      )
      expect(evidenceQueue.start).toHaveBeenCalledOnce()
      expect(noteQueue.start).not.toHaveBeenCalled()
      expect(answerQueue.start).not.toHaveBeenCalled()
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
    expect(questionQueue.close).toHaveBeenCalledOnce()
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
      {} as CourseGenerationJobProcessor,
      { timeoutExpired: vi.fn().mockResolvedValue([]) } as unknown as CourseGenerationRunRepository,
      {} as CourseQuestionJobProcessor,
      {
        timeoutExpired: vi.fn().mockResolvedValue([]),
      } as unknown as CourseQuestionExecutionRepository,
      {} as GitHubEvidenceJobProcessor,
      {} as NoteVerificationJobProcessor,
      {} as NoteVerificationRunRepository,
      {} as AnswerVerificationJobProcessor,
      {} as AnswerVerificationRunRepository,
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
    const answerProcessor = {} as AnswerVerificationJobProcessor
    const reconcileAnswer = vi.fn().mockResolvedValue(0)
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
      {} as CourseGenerationJobProcessor,
      { timeoutExpired: vi.fn().mockResolvedValue([]) } as unknown as CourseGenerationRunRepository,
      {} as CourseQuestionJobProcessor,
      {
        timeoutExpired: vi.fn().mockResolvedValue([]),
      } as unknown as CourseQuestionExecutionRepository,
      {} as GitHubEvidenceJobProcessor,
      noteProcessor,
      { reconcile } as unknown as NoteVerificationRunRepository,
      answerProcessor,
      { reconcile: reconcileAnswer } as unknown as AnswerVerificationRunRepository,
    )
    try {
      await runtime.onApplicationBootstrap()
      expect(noteQueue.constructed).toHaveBeenCalledWith(
        expect.objectContaining({ processor: noteProcessor }),
      )
      expect(noteQueue.start).toHaveBeenCalledOnce()
      expect(answerQueue.constructed).toHaveBeenCalledWith(
        expect.objectContaining({ processor: answerProcessor }),
      )
      expect(answerQueue.start).toHaveBeenCalledOnce()
      expect(reconcileAnswer).toHaveBeenCalledWith(expect.any(Number), expect.any(Function))
      expect(reconcile).toHaveBeenCalledWith(expect.any(Number), expect.any(Function))
    } finally {
      await runtime.onApplicationShutdown()
      vi.restoreAllMocks()
    }
    expect(noteQueue.close).toHaveBeenCalledOnce()
    expect(answerQueue.close).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })
})
