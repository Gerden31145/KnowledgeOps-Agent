import { Module } from '@nestjs/common'
import { API_ENVIRONMENT } from '../config/config.module.js'
import type { ApiEnvironment } from '../config/environment.js'
import { DatabaseService } from '../database/database.service.js'
import { GitHubWebhookController } from './github-webhook.controller.js'
import { GitHubWebhookService } from './github-webhook.service.js'

@Module({
  controllers: [GitHubWebhookController],
  providers: [
    {
      provide: GitHubWebhookService,
      inject: [DatabaseService, API_ENVIRONMENT],
      useFactory: (db: DatabaseService, env: ApiEnvironment) =>
        new GitHubWebhookService(db.client, env.GITHUB_WEBHOOK_SECRET),
    },
  ],
})
export class GitHubWebhookModule {}
