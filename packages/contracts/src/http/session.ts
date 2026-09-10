import { z } from 'zod'

export const sessionResponseSchema = z.object({
  user: z.object({
    id: z.uuid(),
    githubLogin: z.string().min(1).max(100),
    timezone: z.string().min(1),
  }),
})

export type SessionResponse = z.infer<typeof sessionResponseSchema>
