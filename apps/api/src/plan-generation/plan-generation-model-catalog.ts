import type { ApiEnvironment } from '../config/environment.js'

export interface PlanGenerationModelSnapshot {
  catalogId: string
  provider: string
  modelName: string
  promptVersion: string
  outputSchemaVersion: string
}

export class PlanGenerationModelCatalog {
  constructor(
    private readonly models: ApiEnvironment['PLAN_GENERATION_MODELS_JSON'],
    private readonly promptVersion: string,
    private readonly outputSchemaVersion: string,
  ) {}

  resolve(catalogId: string): PlanGenerationModelSnapshot | undefined {
    const configuredModel = this.models.find((model) => model.id === catalogId)

    if (!configuredModel) {
      return undefined
    }

    return {
      catalogId: configuredModel.id,
      provider: configuredModel.provider,
      modelName: configuredModel.model,
      promptVersion: this.promptVersion,
      outputSchemaVersion: this.outputSchemaVersion,
    }
  }
}
