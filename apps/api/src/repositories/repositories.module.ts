import { Module } from '@nestjs/common'
import { API_ENVIRONMENT } from '../config/config.module.js'
import type { ApiEnvironment } from '../config/environment.js'
import { DatabaseService } from '../database/database.service.js'
import { GitHubRepositories } from './github-repositories.js'
import { RepositoryBindingService } from './repository-binding.service.js'
import { RepositoriesController } from './repositories.controller.js'
import { RepositoryEvidenceService } from './repository-evidence.service.js'
import { RepositoryEvidenceRetryService } from './repository-evidence-retry.service.js'

@Module({
  controllers: [RepositoriesController],
  providers: [
    {
      provide: RepositoryEvidenceRetryService,
      inject: [DatabaseService],
      useFactory: (db: DatabaseService) => new RepositoryEvidenceRetryService(db),
    },
    {
      provide: RepositoryEvidenceService,
      inject: [DatabaseService],
      useFactory: (db: DatabaseService) => new RepositoryEvidenceService(db),
    },
    {
      provide: GitHubRepositories,
      inject: [API_ENVIRONMENT],
      useFactory: (env: ApiEnvironment) => new GitHubRepositories(env),
    },
    {
      provide: RepositoryBindingService,
      inject: [DatabaseService, GitHubRepositories],
      useFactory: (db: DatabaseService, github: GitHubRepositories) =>
        new RepositoryBindingService(db, github),
    },
  ],
})
export class RepositoriesModule {}
