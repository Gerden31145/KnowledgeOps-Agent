import { Module } from '@nestjs/common'

import { AppController } from './app.controller.js'
import { ConfigModule } from './config/config.module.js'
import { DatabaseModule } from './database/database.module.js'
import { HealthModule } from './health/health.module.js'
import { IdentityModule } from './identity/identity.module.js'
import { LearningGoalsModule } from './learning-goals/learning-goals.module.js'
import { PlanGenerationModule } from './plan-generation/plan-generation.module.js'
import { PlansModule } from './plans/plans.module.js'

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    IdentityModule,
    LearningGoalsModule,
    HealthModule,
    PlanGenerationModule,
    PlansModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
