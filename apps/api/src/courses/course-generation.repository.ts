import {
  COURSE_GENERATION_OUTPUT_SCHEMA_VERSION,
  COURSE_GENERATION_PROMPT_VERSION,
  courseGenerationRequestedEventPayloadSchema,
  isPlanGenerationRunTerminalState,
  type CourseGenerationAcceptedResponse,
} from '@knowledgeops/contracts'
import { Prisma, type DatabaseClient } from '@knowledgeops/database'
import { randomUUID } from 'node:crypto'

import {
  InvalidPlanLifecycleStateError,
  TaskNotFoundError,
} from '../plans/plan-lifecycle.errors.js'

export async function requestCourseGenerationForTask(
  tx: Prisma.TransactionClient,
  taskId: string,
  now: Date,
  timeoutMs: number,
  retryOfRunId?: string,
): Promise<CourseGenerationAcceptedResponse> {
  const task = await tx.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      type: true,
      state: true,
      course: { select: { id: true, status: true } },
      stage: {
        select: {
          plan: {
            select: {
              status: true,
              generationRun: {
                select: {
                  modelCatalogId: true,
                  modelProvider: true,
                  modelName: true,
                  modelReasoningEffort: true,
                },
              },
            },
          },
        },
      },
    },
  })
  if (!task || task.type !== 'COURSE' || !task.course) throw new TaskNotFoundError()
  if (task.stage.plan.status !== 'ACTIVE' || task.state !== 'READY')
    throw new InvalidPlanLifecycleStateError(
      'Only an unlocked course in the active plan can be generated',
    )
  if (task.course.status === 'READY')
    throw new InvalidPlanLifecycleStateError('The course learning package is already ready')

  const active = await tx.courseGenerationRun.findFirst({
    where: { courseId: task.course.id, status: { in: ['QUEUED', 'RUNNING'] } },
    select: { id: true, status: true },
  })
  if (active)
    return {
      generationRunId: active.id,
      status: active.status === 'RUNNING' ? 'RUNNING' : 'QUEUED',
    }

  if (retryOfRunId) {
    const retry = await tx.courseGenerationRun.findFirst({
      where: { id: retryOfRunId, courseId: task.course.id },
      select: { status: true },
    })
    if (!retry || !isPlanGenerationRunTerminalState(retry.status) || retry.status === 'SUCCEEDED')
      throw new InvalidPlanLifecycleStateError(
        'A failed course generation run is required for retry',
      )
  }

  const model = task.stage.plan.generationRun
  if (!model) throw new InvalidPlanLifecycleStateError('The plan has no frozen model configuration')
  const generationRunId = randomUUID()
  await tx.courseGenerationRun.create({
    data: {
      id: generationRunId,
      courseId: task.course.id,
      modelCatalogId: model.modelCatalogId,
      modelProvider: model.modelProvider,
      modelName: model.modelName,
      modelReasoningEffort: model.modelReasoningEffort,
      promptVersion: COURSE_GENERATION_PROMPT_VERSION,
      outputSchemaVersion: COURSE_GENERATION_OUTPUT_SCHEMA_VERSION,
      profileSnapshot: [],
      deadlineAt: new Date(now.getTime() + timeoutMs),
      queuedAt: now,
      retryOfRunId: retryOfRunId ?? null,
    },
  })
  await tx.course.update({
    where: { id: task.course.id },
    data: { status: 'GENERATING' },
  })
  const payload = courseGenerationRequestedEventPayloadSchema.parse({ generationRunId })
  await tx.outboxEvent.create({
    data: {
      type: 'COURSE_GENERATION_REQUESTED',
      aggregateId: generationRunId,
      deduplicationKey: `course-generation-requested-${generationRunId}`,
      payload,
      occurredAt: now,
      availableAt: now,
    },
  })
  return { generationRunId, status: 'QUEUED' }
}

export class CourseGenerationRepository {
  constructor(
    private readonly database: DatabaseClient,
    private readonly timeoutMs: number,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async request(
    taskId: string,
    actorUserId: string,
    retryOfRunId?: string,
  ): Promise<CourseGenerationAcceptedResponse> {
    return this.database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${actorUserId}::uuid FOR UPDATE`
      const owned = await tx.task.findFirst({
        where: { id: taskId, stage: { plan: { goal: { userId: actorUserId } } } },
        select: { id: true },
      })
      if (!owned) throw new TaskNotFoundError()
      return requestCourseGenerationForTask(tx, taskId, this.clock(), this.timeoutMs, retryOfRunId)
    })
  }
}
