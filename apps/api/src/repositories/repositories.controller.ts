import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common'
import {
  bindRepositoryInputSchema,
  unbindRepositoryInputSchema,
  githubIdSchema,
  repositoryBindingResponseSchema,
  repositoryOptionsResponseSchema,
  githubInstallationsResponseSchema,
  type BindRepositoryInput,
  type UnbindRepositoryInput,
} from '@knowledgeops/contracts'
import { ZodValidationPipe } from '../http/zod-validation.pipe.js'
import { AuthService } from '../identity/auth.service.js'
import type { AuthRequest } from '../identity/auth-http.js'
import { GitHubRepositories } from './github-repositories.js'
import { RepositoryBindingService } from './repository-binding.service.js'

@Controller('repositories')
export class RepositoriesController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(GitHubRepositories) private readonly github: GitHubRepositories,
    @Inject(RepositoryBindingService) private readonly bindings: RepositoryBindingService,
  ) {}

  @Get('binding')
  async current(@Req() request: AuthRequest) {
    return repositoryBindingResponseSchema.parse(
      await this.bindings.current((await this.auth.requireUser(request)).id),
    )
  }

  @Get('installations')
  async installations(@Req() request: AuthRequest) {
    return githubInstallationsResponseSchema.parse(
      await this.github.installations(await this.auth.requireGitHubToken(request)),
    )
  }

  @Get('installations/:installationId')
  async options(
    @Req() request: AuthRequest,
    @Param('installationId', new ZodValidationPipe(githubIdSchema)) installationId: string,
  ) {
    return repositoryOptionsResponseSchema.parse(
      await this.github.repositories(await this.auth.requireGitHubToken(request), installationId),
    )
  }

  @Post('bind')
  @HttpCode(200)
  async bind(
    @Req() request: AuthRequest,
    @Body(new ZodValidationPipe(bindRepositoryInputSchema)) input: BindRepositoryInput,
  ) {
    const user = await this.auth.requireUser(request)
    return repositoryBindingResponseSchema.parse(
      await this.bindings.bind(user.id, await this.auth.requireGitHubToken(request), input),
    )
  }

  @Post('unbind')
  @HttpCode(200)
  async unbind(
    @Req() request: AuthRequest,
    @Body(new ZodValidationPipe(unbindRepositoryInputSchema)) input: UnbindRepositoryInput,
  ) {
    return repositoryBindingResponseSchema.parse(
      await this.bindings.unbind((await this.auth.requireUser(request)).id, input),
    )
  }
}
