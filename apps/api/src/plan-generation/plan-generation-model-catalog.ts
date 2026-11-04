import type {
  PlanGenerationModelOption,
  PlanGenerationModelSnapshot,
} from '@knowledgeops/contracts'

import type { ApiEnvironment } from '../config/environment.js'

export class PlanGenerationModelCatalog {
  constructor(
    private readonly models: ApiEnvironment['PLAN_GENERATION_MODELS_JSON'],
    private readonly provider: ApiEnvironment['PLAN_GENERATION_PROVIDER'],
    private readonly promptVersion: string,
    private readonly outputSchemaVersion: string,
  ) {}

  list(): readonly PlanGenerationModelOption[] {
    return this.models.map((model) => ({
      id: model.id,
      label: model.label ?? model.id,
    }))
  }

  resolve(catalogId: string): PlanGenerationModelSnapshot | undefined {
    const configuredModel = this.models.find((model) => model.id === catalogId)

    if (!configuredModel) {
      return undefined
    }

    return {
      catalogId: configuredModel.id,
      provider: this.provider,
      modelName: configuredModel.model,
      ...(configuredModel.reasoningEffort
        ? { reasoningEffort: configuredModel.reasoningEffort }
        : {}),
      promptVersion: this.promptVersion,
      outputSchemaVersion: this.outputSchemaVersion,
    }
  }
}
