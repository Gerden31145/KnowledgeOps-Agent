import { Module } from '@nestjs/common'

import { API_ENVIRONMENT } from '../config/config.module.js'
import type { ApiEnvironment } from '../config/environment.js'
import { DatabaseService } from '../database/database.service.js'
import { CourseGenerationController } from './course-generation.controller.js'
import { CourseGenerationRepository } from './course-generation.repository.js'

@Module({
  controllers: [CourseGenerationController],
  providers: [
    {
      provide: CourseGenerationRepository,
      inject: [DatabaseService, API_ENVIRONMENT],
      useFactory: (database: DatabaseService, environment: ApiEnvironment) =>
        new CourseGenerationRepository(database.client, environment.PLAN_GENERATION_TIMEOUT_MS),
    },
  ],
})
export class CoursesModule {}
