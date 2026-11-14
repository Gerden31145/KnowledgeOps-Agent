import {
  COURSE_QUESTION_POLICIES,
  generateCourseQuestionAnswer,
  InvalidCourseQuestionAnswerError,
  type CourseQuestionPort,
} from '@knowledgeops/agent-core'
import {
  courseSectionSchema,
  type AskCourseQuestionInput,
  type CourseQuestion,
  type CourseQuestionHistoryResponse,
} from '@knowledgeops/contracts'
import { Prisma, type DatabaseClient } from '@knowledgeops/database'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'

export const COURSE_QUESTION_PORT = Symbol('COURSE_QUESTION_PORT')

const courseContentSchema = z.object({ sections: z.array(courseSectionSchema) }).strict()

export class CourseQuestionNotFoundError extends Error {
  override readonly name = 'CourseQuestionNotFoundError'
}

export class CourseQuestionConflictError extends Error {
  override readonly name = 'CourseQuestionConflictError'
}

export class CourseQuestionUnavailableError extends Error {
  override readonly name = 'CourseQuestionUnavailableError'
}

export class CourseQuestionService {
  constructor(
    private readonly database: DatabaseClient,
    private readonly model: CourseQuestionPort,
    private readonly timeoutMs: number,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async ask(
    userId: string,
    taskId: string,
    input: AskCourseQuestionInput,
  ): Promise<CourseQuestion> {
    const fingerprint = questionFingerprint(taskId, input)
    const existing = await this.findByRequestId(userId, input.requestId)
    if (existing) return replayExisting(existing, taskId, fingerprint)

    const course = await this.database.course.findFirst({
      where: {
        taskId,
        status: 'READY',
        task: { type: 'COURSE', stage: { plan: { status: 'ACTIVE', goal: { userId } } } },
      },
      select: {
        task: {
          select: {
            title: true,
            description: true,
            stage: { select: { plan: { select: { goal: { select: { title: true } } } } } },
          },
        },
        versions: {
          orderBy: { version: 'desc' },
          take: 1,
          select: {
            id: true,
            content: true,
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

    const history = await this.database.courseQuestion.findMany({
      where: { courseVersionId: version.id, userId, status: 'SUCCEEDED' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: COURSE_QUESTION_POLICIES[input.depth].historyLimit,
      select: { question: true, answer: true },
    })
    const model = version.generationRun
    let question
    try {
      question = await this.database.courseQuestion.create({
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
          modelCatalogId: model.modelCatalogId,
          modelProvider: model.modelProvider,
          modelName: model.modelName,
        },
      })
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const duplicate = await this.findByRequestId(userId, input.requestId)
        if (duplicate) return replayExisting(duplicate, taskId, fingerprint)
      }
      throw error
    }

    let candidate
    try {
      candidate = await generateCourseQuestionAnswer(
        this.model,
        {
          model: {
            catalogId: model.modelCatalogId,
            provider: model.modelProvider,
            modelName: model.modelName,
            reasoningEffort: model.modelReasoningEffort,
          },
          goal: course.task.stage.plan.goal.title,
          course: { title: course.task.title, description: course.task.description },
          section,
          selectedText: input.selectedText,
          question: input.question,
          depth: input.depth,
          history: history
            .reverse()
            .map((item) => ({ question: item.question, answer: item.answer! })),
        },
        { signal: AbortSignal.timeout(this.timeoutMs) },
      )
    } catch (error: unknown) {
      await this.database.courseQuestion.updateMany({
        where: { id: question.id, status: 'RUNNING' },
        data: {
          status: 'FAILED',
          errorCode:
            error instanceof InvalidCourseQuestionAnswerError
              ? 'MODEL_OUTPUT_INVALID'
              : 'MODEL_UNAVAILABLE',
          completedAt: this.clock(),
        },
      })
      throw new CourseQuestionUnavailableError()
    }
    const saved = await this.database.courseQuestion.update({
      where: { id: question.id },
      data: {
        status: 'SUCCEEDED',
        answer: candidate.answer,
        completedAt: this.clock(),
        errorCode: null,
      },
    })
    return toResponse(saved)
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

  private findByRequestId(userId: string, requestId: string) {
    return this.database.courseQuestion.findUnique({
      where: { userId_requestId: { userId, requestId } },
      include: { courseVersion: { select: { course: { select: { taskId: true } } } } },
    })
  }
}

function replayExisting(
  existing: NonNullable<Awaited<ReturnType<CourseQuestionService['findByRequestId']>>>,
  taskId: string,
  fingerprint: string,
): CourseQuestion {
  if (
    existing.fingerprint !== fingerprint ||
    existing.courseVersion.course.taskId !== taskId ||
    existing.status !== 'SUCCEEDED' ||
    !existing.answer
  )
    throw new CourseQuestionConflictError('请求已处理或仍在处理，请刷新历史后重试')
  return toResponse(existing)
}

function toResponse(question: {
  id: string
  sectionId: string
  selectedText: string
  question: string
  depth: 'QUICK' | 'CONTEXTUAL' | 'DEEP'
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED'
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
