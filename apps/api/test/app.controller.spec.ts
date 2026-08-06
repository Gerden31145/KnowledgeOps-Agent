import { serviceDescriptorSchema } from '@knowledgeops/contracts'
import { describe, expect, it } from 'vitest'

import { AppController } from '../src/app.controller.js'

describe('AppController', () => {
  it('exposes a contract-valid API shell descriptor', () => {
    const response = new AppController().getServiceDescriptor()

    expect(serviceDescriptorSchema.parse(response)).toEqual({
      service: 'api',
      status: 'ok',
      message: 'KnowledgeOps API skeleton is running',
    })
  })
})
