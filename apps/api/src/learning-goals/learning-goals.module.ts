import { Module, type Provider } from '@nestjs/common'

import { DatabaseService } from '../database/database.service.js'
import { CreateLearningGoalService } from './create-learning-goal.service.js'
import { LearningGoalController } from './learning-goal.controller.js'
import { LearningGoalRepository } from './learning-goal.repository.js'

const learningGoalRepositoryProvider: Provider<LearningGoalRepository> = {
  provide: LearningGoalRepository,
  inject: [DatabaseService],
  useFactory: (database: DatabaseService) => new LearningGoalRepository(database.client),
}

const createLearningGoalProvider: Provider<CreateLearningGoalService> = {
  provide: CreateLearningGoalService,
  inject: [LearningGoalRepository],
  useFactory: (repository: LearningGoalRepository) => new CreateLearningGoalService(repository),
}

@Module({
  controllers: [LearningGoalController],
  providers: [learningGoalRepositoryProvider, createLearningGoalProvider],
})
export class LearningGoalsModule {}
