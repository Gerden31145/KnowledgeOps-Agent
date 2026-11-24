import { gradeCourseMultipleChoice } from '@knowledgeops/agent-core'
import {
  courseExerciseReportSchema,
  courseExerciseRequestedEventPayloadSchema,
  exerciseSetBodySchema,
  multipleChoiceAnswerSchema,
  type CourseExerciseSubmission,
  type CourseExerciseSubmissionHistoryResponse,
  type SubmitCourseExerciseInput,
} from '@knowledgeops/contracts'
import { Prisma, type DatabaseClient } from '@knowledgeops/database'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'

export class CourseExerciseNotFoundError extends Error {
  override readonly name = 'CourseExerciseNotFoundError'
}
export class CourseExerciseConflictError extends Error {
  override readonly name = 'CourseExerciseConflictError'
}

export class CourseExerciseService {
  constructor(
    private readonly database: DatabaseClient,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async submit(
    userId: string,
    taskId: string,
    input: SubmitCourseExerciseInput,
  ): Promise<CourseExerciseSubmission> {
    const fingerprint = submissionFingerprint(taskId, input)
    try {
      return await this.database.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`
        const existing = await findByRequestId(tx, userId, input.requestId)
        if (existing) return replayExisting(existing, taskId, fingerprint)

        const task = await tx.task.findFirst({
          where: { id: taskId, type: 'COURSE', stage: { plan: { goal: { userId } } } },
          select: {
            state: true,
            version: true,
            stage: { select: { plan: { select: { status: true } } } },
            course: {
              select: {
                status: true,
                versions: {
                  orderBy: { version: 'desc' },
                  take: 1,
                  select: {
                    exerciseSet: { select: { id: true, body: true } },
                    generationRun: {
                      select: { modelCatalogId: true, modelProvider: true, modelName: true },
                    },
                  },
                },
              },
            },
          },
        })
        if (!task) throw new CourseExerciseNotFoundError()
        const version = task.course?.versions[0]
        const exerciseSet = version?.exerciseSet
        if (
          task.stage.plan.status !== 'ACTIVE' ||
          task.state !== 'IN_PROGRESS' ||
          task.course?.status !== 'READY' ||
          !version?.generationRun ||
          !exerciseSet
        )
          throw new CourseExerciseConflictError('课程当前不接受练习提交')
        if (task.version !== input.expectedTaskVersion)
          throw new CourseExerciseConflictError('课程状态已变化，请刷新后重新提交')

        const exercises = exerciseSetBodySchema.parse(exerciseSet.body)
        gradeCourseMultipleChoice(exercises, input.multipleChoiceAnswers)
        const active = await tx.courseExerciseSubmission.findFirst({
          where: { exerciseSetId: exerciseSet.id, userId, status: { in: ['QUEUED', 'RUNNING'] } },
          select: { id: true },
        })
        if (active) throw new CourseExerciseConflictError('已有一次练习正在验收，请等待结果')

        const now = this.clock()
        const submission = await tx.courseExerciseSubmission.create({
          data: {
            id: randomUUID(),
            exerciseSetId: exerciseSet.id,
            userId,
            requestId: input.requestId,
            fingerprint,
            expectedTaskVersion: input.expectedTaskVersion,
            multipleChoiceAnswers: input.multipleChoiceAnswers,
            followUpAnswer: input.followUpAnswer,
            status: 'QUEUED',
            modelCatalogId: version.generationRun.modelCatalogId,
            modelProvider: version.generationRun.modelProvider,
            modelName: version.generationRun.modelName,
          },
        })
        const payload = courseExerciseRequestedEventPayloadSchema.parse({
          submissionId: submission.id,
        })
        await tx.outboxEvent.create({
          data: {
            type: 'COURSE_EXERCISE_REQUESTED',
            aggregateId: submission.id,
            deduplicationKey: `course-exercise-requested-${submission.id}`,
            payload,
            occurredAt: now,
            availableAt: now,
          },
        })
        return toResponse(submission)
      })
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const duplicate = await findByRequestId(this.database, userId, input.requestId)
        if (duplicate) return replayExisting(duplicate, taskId, fingerprint)
      }
      throw error
    }
  }

  async history(userId: string, taskId: string): Promise<CourseExerciseSubmissionHistoryResponse> {
    const course = await this.database.course.findFirst({
      where: { taskId, task: { stage: { plan: { goal: { userId } } } } },
      select: {
        versions: {
          orderBy: { version: 'desc' },
          take: 1,
          select: { exerciseSet: { select: { id: true } } },
        },
      },
    })
    const exerciseSetId = course?.versions[0]?.exerciseSet?.id
    if (!exerciseSetId) throw new CourseExerciseNotFoundError()
    const submissions = await this.database.courseExerciseSubmission.findMany({
      where: { exerciseSetId, userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 20,
    })
    return { submissions: submissions.map(toResponse) }
  }

  async active(userId: string, taskId: string): Promise<CourseExerciseSubmission | null> {
    const course = await this.database.course.findFirst({
      where: { taskId, task: { stage: { plan: { goal: { userId } } } } },
      select: {
        versions: {
          orderBy: { version: 'desc' },
          take: 1,
          select: { exerciseSet: { select: { id: true } } },
        },
      },
    })
    const exerciseSetId = course?.versions[0]?.exerciseSet?.id
    if (!exerciseSetId) throw new CourseExerciseNotFoundError()
    const submission = await this.database.courseExerciseSubmission.findFirst({
      where: {
        exerciseSetId,
        userId,
        status: { in: ['QUEUED', 'RUNNING'] },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    })
    return submission ? toResponse(submission) : null
  }
}

function findByRequestId(
  database: DatabaseClient | Prisma.TransactionClient,
  userId: string,
  requestId: string,
) {
  return database.courseExerciseSubmission.findUnique({
    where: { userId_requestId: { userId, requestId } },
    include: {
      exerciseSet: {
        select: { courseVersion: { select: { course: { select: { taskId: true } } } } },
      },
    },
  })
}

function replayExisting(
  existing: NonNullable<Awaited<ReturnType<typeof findByRequestId>>>,
  taskId: string,
  fingerprint: string,
): CourseExerciseSubmission {
  if (
    existing.exerciseSet.courseVersion.course.taskId !== taskId ||
    existing.fingerprint !== fingerprint
  )
    throw new CourseExerciseConflictError('提交内容已变化，请使用新的练习请求')
  return toResponse(existing)
}

function submissionFingerprint(taskId: string, input: SubmitCourseExerciseInput): string {
  return createHash('sha256')
    .update(JSON.stringify({ taskId, ...input }))
    .digest('hex')
}

function toResponse(submission: {
  id: string
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'
  multipleChoiceAnswers: unknown
  followUpAnswer: string
  report: unknown
  errorCode: string | null
  createdAt: Date
  completedAt: Date | null
}): CourseExerciseSubmission {
  return {
    id: submission.id,
    status: submission.status,
    answers: {
      multipleChoiceAnswers: z
        .array(multipleChoiceAnswerSchema)
        .parse(submission.multipleChoiceAnswers),
      followUpAnswer: submission.followUpAnswer,
    },
    report: submission.report ? courseExerciseReportSchema.parse(submission.report) : null,
    errorCode: submission.errorCode,
    createdAt: submission.createdAt.toISOString(),
    completedAt: submission.completedAt?.toISOString() ?? null,
  }
}
