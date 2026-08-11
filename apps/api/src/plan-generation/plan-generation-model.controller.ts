import {
  planGenerationModelCatalogResponseSchema,
  type PlanGenerationModelCatalogResponse,
} from '@knowledgeops/contracts'
import { Controller, Get } from '@nestjs/common'

import { PlanGenerationModelCatalog } from './plan-generation-model-catalog.js'

@Controller('plan-generation-models')
export class PlanGenerationModelController {
  constructor(private readonly modelCatalog: PlanGenerationModelCatalog) {}

  @Get()
  list(): PlanGenerationModelCatalogResponse {
    return planGenerationModelCatalogResponseSchema.parse({
      models: this.modelCatalog.list(),
    })
  }
}
