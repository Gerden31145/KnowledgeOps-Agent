import { Module } from '@nestjs/common'

import { AppController } from './app.controller.js'
import { ConfigModule } from './config/config.module.js'
import { HealthModule } from './health/health.module.js'

@Module({
  imports: [ConfigModule, HealthModule],
  controllers: [AppController],
})
export class AppModule {}
