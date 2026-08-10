import { BadRequestException } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { ZodValidationPipe } from '../src/http/zod-validation.pipe.js'

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe(
    z
      .object({
        name: z.string().trim().min(2),
      })
      .strict(),
  )

  it('returns the parsed and normalized value', () => {
    expect(pipe.transform({ name: '  goal  ' })).toEqual({ name: 'goal' })
  })

  it('maps runtime contract failures to HTTP 400 without echoing the input', () => {
    expect(() => pipe.transform({ name: 'x', apiKey: 'secret' })).toThrow(BadRequestException)

    try {
      pipe.transform({ name: 'x', apiKey: 'secret' })
    } catch (error: unknown) {
      const response = (error as BadRequestException).getResponse()
      expect(JSON.stringify(response)).not.toContain('secret')
    }
  })
})
