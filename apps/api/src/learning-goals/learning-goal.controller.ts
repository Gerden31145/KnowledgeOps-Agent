import { learningGoalResponseSchema, type LearningGoalResponse } from '@knowledgeops/contracts'
import { BadRequestException, Body, Controller, Inject, Post } from '@nestjs/common'

import { CURRENT_ACTOR, type CurrentActor } from '../identity/current-actor.js'
import { CreateLearningGoalService } from './create-learning-goal.service.js'
import { InvalidLearningGoalInputError } from './learning-goal.errors.js'

@Controller('learning-goals')
export class LearningGoalController {
  constructor(
    @Inject(CreateLearningGoalService)
    private readonly createLearningGoal: CreateLearningGoalService,
    @Inject(CURRENT_ACTOR) private readonly currentActor: CurrentActor,
  ) {}

  @Post()
  async create(@Body() input: unknown): Promise<LearningGoalResponse> {
    try {
      const goal = await this.createLearningGoal.execute({
        actorUserId: this.currentActor.userId,
        actorTimezone: this.currentActor.timezone,
        input,
      })

      return learningGoalResponseSchema.parse(goal)
    } catch (error: unknown) {
      if (error instanceof InvalidLearningGoalInputError) {
        throw new BadRequestException({
          code: 'VALIDATION_ERROR',
          message: error.message,
          issues: error.issues.map((issue) => ({
            message: issue.message,
            path: issue.path,
          })),
        })
      }

      throw error
    }
  }
}
