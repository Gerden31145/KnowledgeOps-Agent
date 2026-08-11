import { describe, expect, it } from 'vitest'

import { PlanGenerationModelController } from '../src/plan-generation/plan-generation-model.controller.js'
import { PlanGenerationModelCatalog } from '../src/plan-generation/plan-generation-model-catalog.js'

describe('PlanGenerationModelController', () => {
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
