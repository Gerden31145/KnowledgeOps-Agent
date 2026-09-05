import {
  learningGoalResponseSchema,
  type LearningGoalInput,
  type LearningGoalResponse,
} from '@knowledgeops/contracts'
import type { DatabaseClient } from '@knowledgeops/database'

export interface CreateLearningGoalCommand {
  actorUserId: string
  actorTimezone: string
  input: LearningGoalInput
  createdAt: Date
}

export class LearningGoalRepository {
  constructor(private readonly database: DatabaseClient) {}

  async create(command: CreateLearningGoalCommand): Promise<LearningGoalResponse> {
    const goal = await this.database.$transaction(async (transaction) => {
      await transaction.user.upsert({
        where: { id: command.actorUserId },
        create: {
          id: command.actorUserId,
          timezone: command.actorTimezone,
        },
        update: {
          timezone: command.actorTimezone,
        },
      })

      return transaction.learningGoal.create({
        data: {
          userId: command.actorUserId,
          title: command.input.title,
          currentLevel: command.input.currentLevel,
          deadline: new Date(`${command.input.deadline}T00:00:00.000Z`),
          weeklyMinutes: command.input.weeklyMinutes,
          createdAt: command.createdAt,
        },
        select: {
          id: true,
          title: true,
          currentLevel: true,
          deadline: true,
          weeklyMinutes: true,
          createdAt: true,
        },
      })
    })

    return learningGoalResponseSchema.parse({
      ...goal,
      deadline: goal.deadline.toISOString().slice(0, 10),
      createdAt: goal.createdAt.toISOString(),
    })
  }
}
