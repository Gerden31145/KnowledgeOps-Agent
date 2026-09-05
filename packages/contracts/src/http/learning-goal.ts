import { z } from 'zod'
import { entityIdSchema, isoDateSchema, isoDateTimeSchema } from '../shared/primitives.js'

export const LEARNING_GOAL_INPUT_LIMITS = {
  title: {
    minLength: 3,
    maxLength: 160,
  },
  currentLevel: {
    minLength: 2,
    maxLength: 500,
  },
  weeklyMinutes: {
    min: 60,
    max: 2_400,
  },
  deadline: {
    maxDaysFromToday: 90,
  },
} as const

export function createLearningGoalInputSchema(today: string) {
  return z
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
      deadline: isoDateSchema.refine((date) => {
        const ONE_DAY_MS = 24 * 60 * 60 * 1000

        const todayMs = Date.parse(`${today}T00:00:00.000Z`)
        const deadlineMs = Date.parse(`${date}T00:00:00.000Z`)

        const daysFromToday = (deadlineMs - todayMs) / ONE_DAY_MS

        return (
          daysFromToday >= 1 &&
          daysFromToday <= LEARNING_GOAL_INPUT_LIMITS.deadline.maxDaysFromToday
        )
      }),
      weeklyMinutes: z
        .number()
        .int()
        .min(LEARNING_GOAL_INPUT_LIMITS.weeklyMinutes.min)
        .max(LEARNING_GOAL_INPUT_LIMITS.weeklyMinutes.max),
    })
    .strict()
}

export const learningGoalResponseSchema = z
  .object({
    id: entityIdSchema,
    title: z.string().trim().min(LEARNING_GOAL_INPUT_LIMITS.title.minLength).max(160),
    currentLevel: z.string().trim().min(LEARNING_GOAL_INPUT_LIMITS.currentLevel.minLength).max(500),
    deadline: isoDateSchema,
    weeklyMinutes: z
      .number()
      .int()
      .min(LEARNING_GOAL_INPUT_LIMITS.weeklyMinutes.min)
      .max(LEARNING_GOAL_INPUT_LIMITS.weeklyMinutes.max),
    createdAt: isoDateTimeSchema,
  })
  .strict()

export type LearningGoalInput = z.infer<ReturnType<typeof createLearningGoalInputSchema>>
export type LearningGoalResponse = z.infer<typeof learningGoalResponseSchema>
