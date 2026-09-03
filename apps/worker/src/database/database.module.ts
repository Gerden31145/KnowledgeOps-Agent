import { Global, Module, type Provider } from '@nestjs/common'

import { WORKER_ENVIRONMENT } from '../config/config.module.js'
import type { WorkerEnvironment } from '../config/environment.js'
import { DatabaseService } from './database.service.js'

const databaseServiceProvider: Provider<DatabaseService> = {
  provide: DatabaseService,
  inject: [WORKER_ENVIRONMENT],
  useFactory: (environment: WorkerEnvironment) => new DatabaseService(environment.DATABASE_URL),
}

@Global()
@Module({
  providers: [databaseServiceProvider],
  exports: [DatabaseService],
})
export class DatabaseModule {}
