import type {
  PlanGenerationAcceptedResponse,
  StartPlanGenerationInput,
} from '@knowledgeops/contracts'

import { UnknownPlanGenerationModelError } from './plan-generation.errors.js'
import { PlanGenerationModelCatalog } from './plan-generation-model-catalog.js'
import { PlanGenerationRepository } from './plan-generation.repository.js'

export interface AcceptPlanGenerationRequest {
  actorUserId: string
  goalId: string
  input: StartPlanGenerationInput
}

type Clock = () => Date

export class AcceptPlanGenerationService {
  constructor(
    private readonly repository: PlanGenerationRepository,
    private readonly modelCatalog: PlanGenerationModelCatalog,
    private readonly timeoutMs: number,
    private readonly clock: Clock = () => new Date(),
  ) {}

  async execute(request: AcceptPlanGenerationRequest): Promise<PlanGenerationAcceptedResponse> {
    const model = this.modelCatalog.resolve(request.input.modelId)

    if (!model) {
      throw new UnknownPlanGenerationModelError(request.input.modelId)
    }

    const queuedAt = this.clock()
    const deadlineAt = new Date(queuedAt.getTime() + this.timeoutMs)

    return this.repository.accept({
      actorUserId: request.actorUserId,
      goalId: request.goalId,
      model,
      queuedAt,
      deadlineAt,
      ...(request.input.retryOfRunId ? { retryOfRunId: request.input.retryOfRunId } : {}),
    })
  }
}
