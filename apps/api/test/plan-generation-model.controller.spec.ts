import { describe, expect, it } from 'vitest'

import { PlanGenerationModelController } from '../src/plan-generation/plan-generation-model.controller.js'
import { PlanGenerationModelCatalog } from '../src/plan-generation/plan-generation-model-catalog.js'
import { readApiEnvironment } from '../src/config/environment.js'

describe('PlanGenerationModelController', () => {
  it('accepts and resolves reasoning effort without exposing it in the browser catalog', () => {
    const environment = readApiEnvironment({
      PLAN_GENERATION_MODELS_JSON: JSON.stringify([
        { id: 'glm-primary', model: 'glm-5.3', reasoningEffort: 'low' },
      ]),
    })
    const catalog = new PlanGenerationModelCatalog(
      environment.PLAN_GENERATION_MODELS_JSON,
      'openai',
      'plan-generation-v2',
      'plan-generation-output-v2',
    )
    expect(catalog.resolve('glm-primary')).toMatchObject({ reasoningEffort: 'low' })
    expect(catalog.list()).toEqual([{ id: 'glm-primary', label: 'glm-primary' }])
    expect(() =>
      readApiEnvironment({
        PLAN_GENERATION_MODELS_JSON:
          '[{"id":"glm-primary","model":"glm-5.3","reasoningEffort":"disabled"}]',
      }),
    ).toThrow('PLAN_GENERATION_MODELS_JSON')
  })
  it('returns only the browser-safe model catalog', () => {
    const catalog = new PlanGenerationModelCatalog(
      [
        {
          id: 'openai-primary',
          label: 'Fast model',
          model: 'provider-internal-model-name',
        },
      ],
      'openai',
      'plan-generation-v1',
      'plan-generation-output-v1',
    )
    const controller = new PlanGenerationModelController(catalog)

    expect(controller.list()).toEqual({
      models: [{ id: 'openai-primary', label: 'Fast model' }],
    })
    expect(JSON.stringify(controller.list())).not.toContain('provider-internal-model-name')
  })
})
