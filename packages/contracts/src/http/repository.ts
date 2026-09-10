import { z } from 'zod'

export const githubIdSchema = z
  .string()
  .regex(/^[1-9]\d{0,15}$/)
  .refine(
    (value) => Number.isSafeInteger(Number(value)),
    'GitHub ID must be a safe positive integer',
  )
export const repositoryOptionSchema = z
  .object({
    githubRepositoryId: githubIdSchema,
    fullName: z.string().min(3).max(220),
    defaultBranch: z.string().min(1).max(255),
    isPrivate: z.boolean(),
  })
  .strict()
export const repositoryBindingResponseSchema = z
  .object({
    version: z.number().int().nonnegative(),
    repository: repositoryOptionSchema
      .extend({
        id: z.uuid(),
        installationId: githubIdSchema,
        branch: z.string().min(1).max(255),
      })
      .strict()
      .nullable(),
  })
  .strict()
export const githubInstallationsResponseSchema = z
  .object({
    installUrl: z.string().regex(/^https:\/\/github\.com\/apps\/[a-z0-9-]+\/installations\/new$/),
    installations: z.array(
      z.object({ id: githubIdSchema, accountLogin: z.string().min(1).max(100) }).strict(),
    ),
  })
  .strict()
export const repositoryOptionsResponseSchema = z
  .object({ repositories: z.array(repositoryOptionSchema) })
  .strict()
export const bindRepositoryInputSchema = z
  .object({
    installationId: githubIdSchema,
    githubRepositoryId: githubIdSchema,
    expectedVersion: z.number().int().nonnegative(),
    branch: z.string().trim().min(1).max(255).optional(),
  })
  .strict()
export const unbindRepositoryInputSchema = z
  .object({
    repositoryId: z.uuid(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict()
export type BindRepositoryInput = z.infer<typeof bindRepositoryInputSchema>
export type UnbindRepositoryInput = z.infer<typeof unbindRepositoryInputSchema>
export type RepositoryBindingResponse = z.infer<typeof repositoryBindingResponseSchema>
export type GitHubInstallationsResponse = z.infer<typeof githubInstallationsResponseSchema>
export type RepositoryOptionsResponse = z.infer<typeof repositoryOptionsResponseSchema>
