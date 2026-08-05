import { describe, expect, it } from 'vitest'

import { isServiceName, SERVICE_NAMES } from '../src/index.js'

describe('service name contract', () => {
  it('keeps the three process names in one shared contract', () => {
    expect(SERVICE_NAMES).toEqual(['web', 'api', 'worker'])
  })

  it('rejects names outside the process boundary', () => {
    expect(isServiceName('api')).toBe(true)
    expect(isServiceName('database')).toBe(false)
  })
})
