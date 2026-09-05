import { Test } from '@nestjs/testing'
import { describe, expect, it } from 'vitest'

import { AppModule } from '../src/app.module.js'

describe('AppModule dependency graph', () => {
  it('resolves every controller dependency without relying on dev-runner metadata', async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile()

    expect(module).toBeDefined()
    await module.close()
  })
})
