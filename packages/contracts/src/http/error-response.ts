import { z } from 'zod'

export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'RESOURCE_NOT_FOUND',
  'CONFLICT',
  'INVALID_STATE_TRANSITION',
  'DEPENDENCY_UNAVAILABLE',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const

export const errorCodeSchema = z.enum(ERROR_CODES)

export type ErrorCode = z.infer<typeof errorCodeSchema>

export const apiErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: errorCodeSchema,
        message: z.string().min(1),
        requestId: z.string().min(1).max(128),
        details: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
  })
  .strict()

export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>
