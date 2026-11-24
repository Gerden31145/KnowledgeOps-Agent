import { z } from 'zod'

import { agentRunKindSchema } from '../dto/agent-run.dto.js'
import { agentRunStateSchema } from '../domain/agent-run-state.js'
import {
  acceptanceCriterionTypeSchema,
  markdownTargetPathSchema,
  planStatusSchema,
  taskTypeSchema,
} from '../domain/plan.js'
import { CURRENT_TASK_STATES, taskStateSchema } from '../domain/task-state.js'
import {
  courseGenerationSummarySchema,
  courseSectionSchema,
  publicExerciseSetSchema,
} from '../domain/course.js'
import { entityIdSchema, isoDateSchema, isoDateTimeSchema } from '../shared/primitives.js'

export const acceptanceCriterionSummarySchema = z
  .object({
    id: entityIdSchema,
    type: acceptanceCriterionTypeSchema,
    description: z.string().trim().min(1),
    parameterDescription: z.string().trim().min(1).nullable().default(null),
    required: z.boolean(),
    position: z.number().int().nonnegative(),
  })
  .strict()

export const planTaskSummarySchema = z
  .object({
    id: entityIdSchema,
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1),
    position: z.number().int().nonnegative(),
    type: taskTypeSchema,
    estimatedMinutes: z.number().int().positive(),
    suggestedSteps: z.array(z.string().trim().min(1)),
    targetPath: markdownTargetPathSchema.nullable(),
    state: taskStateSchema,
    version: z.number().int().nonnegative(),
    prerequisiteTaskIds: z.array(entityIdSchema),
    criteria: z.array(acceptanceCriterionSummarySchema),
    course: courseGenerationSummarySchema.nullable(),
  })
  .strict()

export const planDetailResponseSchema = z
  .object({
    id: entityIdSchema,
    version: z.number().int().positive(),
    status: planStatusSchema,
    confirmedAt: isoDateTimeSchema.nullable(),
    goal: z
      .object({
        id: entityIdSchema,
        title: z.string().trim().min(1).max(160),
        deadline: isoDateSchema,
        weeklyMinutes: z.number().int().positive(),
      })
      .strict(),
    stages: z.array(
      z
        .object({
          id: entityIdSchema,
          title: z.string().trim().min(1).max(160),
          position: z.number().int().nonnegative(),
          tasks: z.array(planTaskSummarySchema),
        })
        .strict(),
    ),
  })
  .strict()

const todayTaskStateSchema = taskStateSchema.extract(['READY', ...CURRENT_TASK_STATES])

export const todayTasksResponseSchema = z
  .object({
    plan: z
      .object({
        id: entityIdSchema,
        status: planStatusSchema.extract(['ACTIVE']),
      })
      .strict()
      .nullable(),
    tasks: z.array(
      z
        .object({
          id: entityIdSchema,
          planId: entityIdSchema,
          title: z.string().trim().min(1).max(160),
          description: z.string().trim().min(1),
          estimatedMinutes: z.number().int().positive(),
          targetPath: markdownTargetPathSchema.nullable(),
          state: todayTaskStateSchema,
          updatedAt: isoDateTimeSchema,
          stage: z
            .object({
              id: entityIdSchema,
              title: z.string().trim().min(1).max(160),
              position: z.number().int().nonnegative(),
            })
            .strict(),
        })
        .strict(),
    ),
  })
  .strict()

export const taskDetailResponseSchema = planTaskSummarySchema
  .extend({
    course: courseGenerationSummarySchema
      .extend({
        sections: z.array(courseSectionSchema).nullable(),
        exercises: publicExerciseSetSchema.nullable(),
      })
      .nullable(),
    stage: z
      .object({
        id: entityIdSchema,
        title: z.string().trim().min(1).max(160),
        position: z.number().int().nonnegative(),
        plan: z
          .object({
            id: entityIdSchema,
            status: planStatusSchema,
          })
          .strict(),
      })
      .strict(),
    runs: z.array(
      z
        .object({
          id: entityIdSchema,
          kind: agentRunKindSchema,
          status: agentRunStateSchema,
          errorCode: z.string().trim().min(1).nullable(),
          queuedAt: isoDateTimeSchema,
          startedAt: isoDateTimeSchema.nullable(),
          finishedAt: isoDateTimeSchema.nullable(),
        })
        .strict(),
    ),
  })
  .strict()

export const taskSummaryResponseSchema = taskDetailResponseSchema.omit({ course: true }).extend({
  course: courseGenerationSummarySchema.nullable(),
})

export type AcceptanceCriterionSummary = z.infer<typeof acceptanceCriterionSummarySchema>
export type PlanTaskSummary = z.infer<typeof planTaskSummarySchema>
export type PlanDetailResponse = z.infer<typeof planDetailResponseSchema>
export type TodayTasksResponse = z.infer<typeof todayTasksResponseSchema>
export type TaskDetailResponse = z.infer<typeof taskDetailResponseSchema>
export type TaskSummaryResponse = z.infer<typeof taskSummaryResponseSchema>

// 默认入口只返回当前用户的恢复定位；完整计划和运行仍走原有查询。
export const workspaceEntryResponseSchema = z
  .object({
    planId: entityIdSchema.nullable(),
    runId: entityIdSchema.nullable(),
    modelId: z.string().nullable(),
    goal: z
      .object({
        id: entityIdSchema,
        title: z.string(),
        currentLevel: z.string(),
        deadline: isoDateSchema,
        weeklyMinutes: z.number().int().positive(),
      })
      .strict()
      .nullable(),
  })
  .strict()
export type WorkspaceEntryResponse = z.infer<typeof workspaceEntryResponseSchema>
