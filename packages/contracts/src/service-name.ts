import { z } from 'zod'

export const SERVICE_NAMES = ['web', 'api', 'worker'] as const

export const serviceNameSchema = z.enum(SERVICE_NAMES)

export type ServiceName = z.infer<typeof serviceNameSchema>

export function isServiceName(value: string): value is ServiceName {
  return SERVICE_NAMES.some((serviceName) => serviceName === value)
}
