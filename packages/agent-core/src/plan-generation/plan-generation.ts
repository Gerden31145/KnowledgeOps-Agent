import {
  LEARNING_GOAL_INPUT_LIMITS,
  entityIdSchema,
  isoDateSchema,
  planGenerationModelSnapshotSchema,
  planTaskAcceptanceCriterionTypeSchema,
} from '@knowledgeops/contracts'
import { z } from 'zod'

const ONE_DAY_MS = 24 * 60 * 60 * 1_000

export const PLAN_GENERATION_LIMITS = {
  stages: { min: 1, max: 3 },
  tasks: { min: 3, max: 8 },
  taskMinutes: { min: 15, max: 480 },
  suggestedSteps: { min: 1, max: 6 },
  acceptanceCriteria: { min: 1, max: 6 },
} as const

export const PLAN_GENERATION_PROMPT_VERSION = 'plan-generation-v1'
export const PLAN_GENERATION_OUTPUT_SCHEMA_VERSION = 'plan-generation-output-v1'

const taskReferenceIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,63}$/)
  .describe('A temporary task ID such as task-1, unique across the whole plan')

const markdownTargetPathSchema = z
  .string()
  .trim()
  .min(3)
  .max(1_024)
  .regex(/^(?!\/)(?![a-zA-Z]:)(?!.*(?:^|\/)\.\.(?:\/|$)).+\.md$/i)
  .describe('A repository-relative Markdown path without parent traversal')

const planGenerationGoalSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(LEARNING_GOAL_INPUT_LIMITS.title.minLength)
      .max(LEARNING_GOAL_INPUT_LIMITS.title.maxLength),
    currentLevel: z
      .string()
      .trim()
      .min(LEARNING_GOAL_INPUT_LIMITS.currentLevel.minLength)
      .max(LEARNING_GOAL_INPUT_LIMITS.currentLevel.maxLength),
    today: isoDateSchema,
    deadline: isoDateSchema,
    weeklyMinutes: z
      .number()
      .int()
      .min(LEARNING_GOAL_INPUT_LIMITS.weeklyMinutes.min)
      .max(LEARNING_GOAL_INPUT_LIMITS.weeklyMinutes.max),
  })
  .strict()
  .refine(
    ({ today, deadline }) => {
      const todayMs = Date.parse(`${today}T00:00:00.000Z`)
      const deadlineMs = Date.parse(`${deadline}T00:00:00.000Z`)
      const daysFromToday = (deadlineMs - todayMs) / ONE_DAY_MS

      return (
        daysFromToday >= 1 && daysFromToday <= LEARNING_GOAL_INPUT_LIMITS.deadline.maxDaysFromToday
      )
    },
    {
      message: `deadline must be 1-${LEARNING_GOAL_INPUT_LIMITS.deadline.maxDaysFromToday} days after today`,
      path: ['deadline'],
    },
  )

export const planGenerationRequestSchema = z
  .object({
    generationRunId: entityIdSchema,
    model: planGenerationModelSnapshotSchema,
    goal: planGenerationGoalSchema,
  })
  .strict()

const generatedAcceptanceCriterionSchema = z
  .object({
    type: planTaskAcceptanceCriterionTypeSchema,
    description: z.string().trim().min(5).max(500),
    required: z.boolean(),
  })
  .strict()

const generatedTaskSchema = z
  .object({
    id: taskReferenceIdSchema,
    title: z.string().trim().min(3).max(160),
    description: z.string().trim().min(10).max(1_000),
    type: z.literal('MARKDOWN_NOTE'),
    estimatedMinutes: z
      .number()
      .int()
      .min(PLAN_GENERATION_LIMITS.taskMinutes.min)
      .max(PLAN_GENERATION_LIMITS.taskMinutes.max),
    suggestedSteps: z
      .array(z.string().trim().min(3).max(240))
      .min(PLAN_GENERATION_LIMITS.suggestedSteps.min)
      .max(PLAN_GENERATION_LIMITS.suggestedSteps.max),
    targetPath: markdownTargetPathSchema,
    acceptanceCriteria: z
      .array(generatedAcceptanceCriterionSchema)
      .min(PLAN_GENERATION_LIMITS.acceptanceCriteria.min)
      .max(PLAN_GENERATION_LIMITS.acceptanceCriteria.max),
    dependsOnTaskIds: z.array(taskReferenceIdSchema).max(PLAN_GENERATION_LIMITS.tasks.max - 1),
  })
  .strict()

const generatedStageSchema = z
  .object({
    title: z.string().trim().min(3).max(160),
    tasks: z.array(generatedTaskSchema).min(1).max(PLAN_GENERATION_LIMITS.tasks.max),
  })
  .strict()

const planGenerationOutputShapeSchema = z
  .object({
    stages: z
      .array(generatedStageSchema)
      .min(PLAN_GENERATION_LIMITS.stages.min)
      .max(PLAN_GENERATION_LIMITS.stages.max),
  })
  .strict()
  .refine(
    ({ stages }) => {
      const taskCount = stages.reduce((count, stage) => count + stage.tasks.length, 0)

      return (
        taskCount >= PLAN_GENERATION_LIMITS.tasks.min &&
        taskCount <= PLAN_GENERATION_LIMITS.tasks.max
      )
    },
    {
      message: `plan must contain ${PLAN_GENERATION_LIMITS.tasks.min}-${PLAN_GENERATION_LIMITS.tasks.max} tasks in total`,
      path: ['stages'],
    },
  )

export const planGenerationOutputSchema = planGenerationOutputShapeSchema.superRefine(
  (plan, context) => {
    // 1. 验证taskId全局唯一
    const taskIdSet = new Set<string>()
    plan.stages.forEach((stage, stageIndex) => {
      stage.tasks.forEach((task, taskIndex) => {
        if (taskIdSet.has(task.id))
          context.addIssue({
            code: 'custom',
            message: 'Task ID must be unique',
            path: ['stages', stageIndex, 'tasks', taskIndex, 'id'],
          })
        else taskIdSet.add(task.id)
      })
    })

    // 2. dependsOnTaskIds必须在taskId集合内
    // 3. Task 不能依赖自己的 ID
    plan.stages.forEach((stage, stageIndex) => {
      stage.tasks.forEach((task, taskIndex) => {
        task.dependsOnTaskIds.forEach((depId, depIdIndex) => {
          if (!taskIdSet.has(depId)) {
            context.addIssue({
              code: 'custom',
              message: 'dependsOnTaskIds not exist',
              path: ['stages', stageIndex, 'tasks', taskIndex, 'dependsOnTaskIds', depIdIndex],
            })
          }
          if (depId === task.id) {
            context.addIssue({
              code: 'custom',
              message: 'Cannot depend on yourself',
              path: ['stages', stageIndex, 'tasks', taskIndex, 'dependsOnTaskIds', depIdIndex],
            })
          }
        })
      })
    })
  },
)

export type PlanGenerationRequest = z.infer<typeof planGenerationRequestSchema>
export type PlanGenerationOutput = z.infer<typeof planGenerationOutputSchema>

export interface PlanGenerationOptions {
  signal?: AbortSignal
}

export interface PlanGenerationPort {
  generate(request: PlanGenerationRequest, options?: PlanGenerationOptions): Promise<unknown>
}

export class InvalidPlanGenerationRequestError extends Error {
  override readonly name = 'InvalidPlanGenerationRequestError'

  constructor(cause: z.ZodError) {
    super('Plan generation request does not satisfy the model port contract', { cause })
  }
}

export class InvalidPlanGenerationOutputError extends Error {
  override readonly name = 'InvalidPlanGenerationOutputError'

  constructor(cause?: unknown) {
    super('Model output does not satisfy the plan generation contract', { cause })
  }
}

export async function generatePlanCandidate(
  port: PlanGenerationPort,
  request: unknown,
  options?: PlanGenerationOptions,
): Promise<PlanGenerationOutput> {
  const parsedRequest = planGenerationRequestSchema.safeParse(request)

  if (!parsedRequest.success) {
    throw new InvalidPlanGenerationRequestError(parsedRequest.error)
  }

  const candidate = await port.generate(parsedRequest.data, options)
  const parsedCandidate = planGenerationOutputSchema.safeParse(candidate)

  if (!parsedCandidate.success) {
    throw new InvalidPlanGenerationOutputError(parsedCandidate.error)
  }

  return parsedCandidate.data
}
