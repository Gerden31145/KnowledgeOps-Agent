import { Global, Module, type Provider } from '@nestjs/common'

import { readApiEnvironment, type ApiEnvironment } from './environment.js'

export const API_ENVIRONMENT = Symbol('API_ENVIRONMENT')

const apiEnvironmentProvider: Provider<ApiEnvironment> = {
  provide: API_ENVIRONMENT,
  useFactory: () => readApiEnvironment(),
}

@Global()
@Module({
  providers: [apiEnvironmentProvider],
  exports: [API_ENVIRONMENT],
})
export class ConfigModule {}
