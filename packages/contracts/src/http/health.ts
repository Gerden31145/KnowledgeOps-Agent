import { z } from 'zod'

import { serviceNameSchema } from '../service-name.js'
import { isoDateTimeSchema } from '../shared/primitives.js'

export const HEALTH_DEPENDENCIES = ['postgresql', 'redis'] as const

export const healthDependencySchema = z.enum(HEALTH_DEPENDENCIES)

export type HealthDependency = z.infer<typeof healthDependencySchema>

export const dependencyHealthSchema = z
  .object({
    status: z.enum(['up', 'down']),
    latencyMs: z.number().nonnegative(),
  })
  .strict()

export type DependencyHealth = z.infer<typeof dependencyHealthSchema>

export const livenessResponseSchema = z
  .object({
    service: serviceNameSchema,
    status: z.literal('alive'),
    timestamp: isoDateTimeSchema,
    uptimeSeconds: z.number().nonnegative(),
  })
  .strict()

export type LivenessResponse = z.infer<typeof livenessResponseSchema>

export const readinessResponseSchema = z
  .object({
    service: serviceNameSchema,
    status: z.enum(['ready', 'not_ready']),
    timestamp: isoDateTimeSchema,
    checks: z
      .object({
        postgresql: dependencyHealthSchema,
        redis: dependencyHealthSchema,
      })
      .strict(),
  })
  .strict()

export type ReadinessResponse = z.infer<typeof readinessResponseSchema>
