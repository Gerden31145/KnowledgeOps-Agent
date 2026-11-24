import {
  courseQuestionRequestedEventPayloadSchema,
  courseSectionSchema,
  type AskCourseQuestionInput,
  type CourseQuestion,
  type CourseQuestionHistoryResponse,
} from '@knowledgeops/contracts'
import { Prisma, type DatabaseClient } from '@knowledgeops/database'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'

const courseContentSchema = z.object({ sections: z.array(courseSectionSchema) }).strict()

export class CourseQuestionNotFoundError extends Error {
  override readonly name = 'CourseQuestionNotFoundError'
}

export class CourseQuestionConflictError extends Error {
  override readonly name = 'CourseQuestionConflictError'
}

export class CourseQuestionService {
  constructor(
    private readonly database: DatabaseClient,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async ask(
    userId: string,
    taskId: string,
    input: AskCourseQuestionInput,
  ): Promise<CourseQuestion> {
    const fingerprint = questionFingerprint(taskId, input)
    try {
      return await this.database.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`
        const existing = await findByRequestId(tx, userId, input.requestId)
        if (existing) return replayExisting(existing, taskId, fingerprint)

        const course = await tx.course.findFirst({
          where: {
            taskId,
            status: 'READY',
            task: { type: 'COURSE', stage: { plan: { status: 'ACTIVE', goal: { userId } } } },
          },
          select: {
            versions: {
              orderBy: { version: 'desc' },
              take: 1,
              select: {
                id: true,
                content: true,
                generationRun: {
                  select: { modelCatalogId: true, modelProvider: true, modelName: true },
                },
              },
            },
          },
        })
        const version = course?.versions[0]
        if (!course || !version) throw new CourseQuestionNotFoundError()
        const content = courseContentSchema.safeParse(version.content)
        if (!content.success) throw new CourseQuestionConflictError('课程内容结构已变化')
        const section = content.data.sections.find((item) => item.id === input.sectionId)
        if (
          !section ||
          !normalizeSelection(sectionText(section)).includes(normalizeSelection(input.selectedText))
        )
          throw new CourseQuestionConflictError('选中文字不属于当前课程区块')

        const now = this.clock()
        const question = await tx.courseQuestion.create({
          data: {
            id: randomUUID(),
            courseVersionId: version.id,
            userId,
            requestId: input.requestId,
            fingerprint,
            sectionId: input.sectionId,
            selectedText: input.selectedText,
            question: input.question,
            depth: input.depth,
            status: 'QUEUED',
            modelCatalogId: version.generationRun.modelCatalogId,
            modelProvider: version.generationRun.modelProvider,
            modelName: version.generationRun.modelName,
          },
        })
        const payload = courseQuestionRequestedEventPayloadSchema.parse({ questionId: question.id })
        await tx.outboxEvent.create({
          data: {
            type: 'COURSE_QUESTION_REQUESTED',
            aggregateId: question.id,
            deduplicationKey: `course-question-requested-${question.id}`,
            payload,
            occurredAt: now,
            availableAt: now,
          },
        })
        return toResponse(question)
      })
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const duplicate = await findByRequestId(this.database, userId, input.requestId)
        if (duplicate) return replayExisting(duplicate, taskId, fingerprint)
      }
      throw error
    }
  }

  async history(userId: string, taskId: string): Promise<CourseQuestionHistoryResponse> {
    const course = await this.database.course.findFirst({
      where: { taskId, task: { stage: { plan: { goal: { userId } } } } },
      select: { versions: { orderBy: { version: 'desc' }, take: 1, select: { id: true } } },
    })
    const version = course?.versions[0]
    if (!version) throw new CourseQuestionNotFoundError()
    const questions = await this.database.courseQuestion.findMany({
      where: { courseVersionId: version.id, userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
    })
    return { questions: questions.reverse().map(toResponse) }
  }

  async active(userId: string, taskId: string): Promise<CourseQuestion | null> {
    const course = await this.database.course.findFirst({
      where: { taskId, task: { stage: { plan: { goal: { userId } } } } },
      select: { versions: { orderBy: { version: 'desc' }, take: 1, select: { id: true } } },
    })
    const version = course?.versions[0]
    if (!version) throw new CourseQuestionNotFoundError()
    const question = await this.database.courseQuestion.findFirst({
      where: {
        courseVersionId: version.id,
        userId,
        status: { in: ['QUEUED', 'RUNNING'] },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    })
    return question ? toResponse(question) : null
  }
}

function findByRequestId(
  database: DatabaseClient | Prisma.TransactionClient,
  userId: string,
  requestId: string,
) {
  return database.courseQuestion.findUnique({
    where: { userId_requestId: { userId, requestId } },
    include: { courseVersion: { select: { course: { select: { taskId: true } } } } },
  })
}

function replayExisting(
  existing: NonNullable<Awaited<ReturnType<typeof findByRequestId>>>,
  taskId: string,
  fingerprint: string,
): CourseQuestion {
  if (existing.fingerprint !== fingerprint || existing.courseVersion.course.taskId !== taskId)
    throw new CourseQuestionConflictError('请求内容已变化，请使用新的提问请求')
  return toResponse(existing)
}

function toResponse(question: {
  id: string
  sectionId: string
  selectedText: string
  question: string
  depth: 'QUICK' | 'CONTEXTUAL' | 'DEEP'
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'
  answer: string | null
  createdAt: Date
  completedAt: Date | null
}): CourseQuestion {
  return {
    id: question.id,
    sectionId: question.sectionId,
    selectedText: question.selectedText,
    question: question.question,
    depth: question.depth,
    status: question.status,
    answer: question.answer,
    createdAt: question.createdAt.toISOString(),
    completedAt: question.completedAt?.toISOString() ?? null,
  }
}

function questionFingerprint(taskId: string, input: AskCourseQuestionInput): string {
  return createHash('sha256')
    .update(JSON.stringify({ taskId, ...input }))
    .digest('hex')
}

function sectionText(section: z.infer<typeof courseSectionSchema>): string {
  return [
    section.title,
    section.explanation,
    '开发情景',
    section.scenario,
    '示例',
    section.example,
    '易错点',
    section.misconception,
  ].join('\n')
}

function normalizeSelection(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}
