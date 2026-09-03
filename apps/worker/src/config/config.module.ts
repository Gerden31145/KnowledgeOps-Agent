import { Global, Module, type Provider } from '@nestjs/common'

import { readWorkerEnvironment, type WorkerEnvironment } from './environment.js'

export const WORKER_ENVIRONMENT = Symbol('WORKER_ENVIRONMENT')

const workerEnvironmentProvider: Provider<WorkerEnvironment> = {
  provide: WORKER_ENVIRONMENT,
  useFactory: () => readWorkerEnvironment(),
}

@Global()
@Module({
  providers: [workerEnvironmentProvider],
  exports: [WORKER_ENVIRONMENT],
})
export class ConfigModule {}
