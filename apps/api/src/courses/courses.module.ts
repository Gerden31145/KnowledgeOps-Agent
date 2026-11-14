import { LangChainCourseQuestionAnswering } from '@knowledgeops/agent-core'
import { Module } from '@nestjs/common'

import { API_ENVIRONMENT } from '../config/config.module.js'
import type { ApiEnvironment } from '../config/environment.js'
import { DatabaseService } from '../database/database.service.js'
import { CourseGenerationController } from './course-generation.controller.js'
import { CourseGenerationRepository } from './course-generation.repository.js'
import { CourseQuestionController } from './course-question.controller.js'
import { COURSE_QUESTION_PORT, CourseQuestionService } from './course-question.service.js'

@Module({
  controllers: [CourseGenerationController, CourseQuestionController],
  providers: [
    {
      provide: CourseGenerationRepository,
      inject: [DatabaseService, API_ENVIRONMENT],
      useFactory: (database: DatabaseService, environment: ApiEnvironment) =>
        new CourseGenerationRepository(database.client, environment.COURSE_GENERATION_TIMEOUT_MS),
    },
    {
      provide: COURSE_QUESTION_PORT,
      inject: [API_ENVIRONMENT],
      useFactory: (environment: ApiEnvironment) =>
        new LangChainCourseQuestionAnswering({
          structuredOutputMethod: environment.PLAN_GENERATION_OUTPUT_METHOD,
          ...(environment.OPENAI_API_KEY ? { apiKey: environment.OPENAI_API_KEY } : {}),
          ...(environment.OPENAI_BASE_URL ? { baseUrl: environment.OPENAI_BASE_URL } : {}),
        }),
    },
    {
      provide: CourseQuestionService,
      inject: [DatabaseService, COURSE_QUESTION_PORT, API_ENVIRONMENT],
      useFactory: (
        database: DatabaseService,
        model: LangChainCourseQuestionAnswering,
        environment: ApiEnvironment,
      ) =>
        new CourseQuestionService(database.client, model, environment.COURSE_QUESTION_TIMEOUT_MS),
    },
  ],
})
export class CoursesModule {}
