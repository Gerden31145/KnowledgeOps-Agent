import { Global, Module, type Provider } from '@nestjs/common'

import { API_ENVIRONMENT } from '../config/config.module.js'
import type { ApiEnvironment } from '../config/environment.js'
import { CURRENT_ACTOR, type CurrentActor } from './current-actor.js'

const currentActorProvider: Provider<CurrentActor> = {
  provide: CURRENT_ACTOR,
  inject: [API_ENVIRONMENT],
  useFactory: (environment: ApiEnvironment) => {
    if (environment.NODE_ENV === 'production') {
      throw new Error('Fixed development identity is disabled in production')
    }

    return {
      userId: environment.DEVELOPMENT_USER_ID,
      timezone: environment.DEVELOPMENT_USER_TIMEZONE,
    }
  },
}

@Global()
@Module({
  providers: [currentActorProvider],
  exports: [CURRENT_ACTOR],
})
export class IdentityModule {}
