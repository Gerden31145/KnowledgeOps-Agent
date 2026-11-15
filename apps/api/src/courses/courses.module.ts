import { Module } from '@nestjs/common'

import { API_ENVIRONMENT } from '../config/config.module.js'
import type { ApiEnvironment } from '../config/environment.js'
import { DatabaseService } from '../database/database.service.js'
import { CourseExerciseController } from './course-exercise.controller.js'
import { CourseExerciseService } from './course-exercise.service.js'
import { CourseGenerationController } from './course-generation.controller.js'
import { CourseGenerationRepository } from './course-generation.repository.js'
import { CourseQuestionController } from './course-question.controller.js'
import { CourseQuestionService } from './course-question.service.js'

@Module({
  controllers: [CourseGenerationController, CourseQuestionController, CourseExerciseController],
  providers: [
    {
      provide: CourseGenerationRepository,
      inject: [DatabaseService, API_ENVIRONMENT],
      useFactory: (database: DatabaseService, environment: ApiEnvironment) =>
        new CourseGenerationRepository(database.client, environment.COURSE_GENERATION_TIMEOUT_MS),
    },
    {
      provide: CourseQuestionService,
      inject: [DatabaseService],
      useFactory: (database: DatabaseService) => new CourseQuestionService(database.client),
    },
    {
      provide: CourseExerciseService,
      inject: [DatabaseService],
      useFactory: (database: DatabaseService) => new CourseExerciseService(database.client),
    },
  ],
})
export class CoursesModule {}
