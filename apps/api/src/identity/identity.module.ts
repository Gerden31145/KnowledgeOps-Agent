import { Global, Module, Scope, type Provider } from '@nestjs/common'
import { APP_GUARD, REQUEST } from '@nestjs/core'

import { API_ENVIRONMENT } from '../config/config.module.js'
import type { ApiEnvironment } from '../config/environment.js'
import { DatabaseService } from '../database/database.service.js'
import { AuthController } from './auth.controller.js'
import { AuthGuard } from './auth.guard.js'
import type { AuthRequest } from './auth-http.js'
import { AuthService } from './auth.service.js'
import { CURRENT_ACTOR, type CurrentActor } from './current-actor.js'

const currentActorProvider: Provider<CurrentActor> = {
  provide: CURRENT_ACTOR,
  scope: Scope.REQUEST,
  inject: [REQUEST, AuthService],
  useFactory: async (request: AuthRequest, auth: AuthService) => {
    // Provider 可能先于 Guard 创建；两者复用同一次会话查询，不能假定 Guard 已填好用户。
    const user = await auth.requireUser(request)
    return { userId: user.id, timezone: user.timezone }
  },
}

@Global()
@Module({
  controllers: [AuthController],
  providers: [
    {
      provide: AuthService,
      inject: [DatabaseService, API_ENVIRONMENT],
      useFactory: (database: DatabaseService, environment: ApiEnvironment) =>
        new AuthService(database, environment),
    },
    { provide: APP_GUARD, useClass: AuthGuard },
    currentActorProvider,
  ],
  exports: [CURRENT_ACTOR, AuthService],
})
export class IdentityModule {}
