import { z } from 'zod'

import { serviceNameSchema } from '../service-name.js'

/** Small runtime contract exposed by an application shell before business routes exist. */
export const serviceDescriptorSchema = z
  .object({
    service: serviceNameSchema,
    status: z.literal('ok'),
    message: z.string().trim().min(1).max(160),
  })
  .strict()

export type ServiceDescriptor = z.infer<typeof serviceDescriptorSchema>
