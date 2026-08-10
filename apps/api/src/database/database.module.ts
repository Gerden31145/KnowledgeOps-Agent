import { Global, Module, type Provider } from '@nestjs/common'

import { API_ENVIRONMENT } from '../config/config.module.js'
import type { ApiEnvironment } from '../config/environment.js'
import { DatabaseService } from './database.service.js'

const databaseServiceProvider: Provider<DatabaseService> = {
  provide: DatabaseService,
  inject: [API_ENVIRONMENT],
  useFactory: (environment: ApiEnvironment) => new DatabaseService(environment.DATABASE_URL),
}

@Global()
@Module({
  providers: [databaseServiceProvider],
  exports: [DatabaseService],
})
export class DatabaseModule {}
