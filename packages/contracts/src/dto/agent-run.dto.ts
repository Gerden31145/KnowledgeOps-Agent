import { z } from 'zod'

import { agentRunStateSchema, isAgentRunTerminalState } from '../domain/agent-run-state.js'
import { restorableTaskStateSchema } from '../domain/task-state.js'
import { entityIdSchema, isoDateTimeSchema } from '../shared/primitives.js'

export const AGENT_RUN_KINDS = ['NOTE_VERIFICATION', 'ANSWER_VERIFICATION'] as const

export const agentRunKindSchema = z.enum(AGENT_RUN_KINDS)

export type AgentRunKind = z.infer<typeof agentRunKindSchema>

/** One immutable execution attempt. Retrying creates another DTO linked by retryOfRunId. */
export const agentRunDtoSchema = z
  .object({
    id: entityIdSchema,
    taskId: entityIdSchema,
    kind: agentRunKindSchema,
    status: agentRunStateSchema,
    taskStateBeforeRun: restorableTaskStateSchema,
    retryOfRunId: entityIdSchema.nullable(),
    workflowVersion: z.string().trim().min(1).max(64),
    version: z.number().int().nonnegative(),
    queuedAt: isoDateTimeSchema,
    startedAt: isoDateTimeSchema.nullable(),
    finishedAt: isoDateTimeSchema.nullable(),
  })
  .strict()
  .superRefine((run, context) => {
    const isTerminal = isAgentRunTerminalState(run.status)

    if (isTerminal && run.finishedAt === null) {
      context.addIssue({
        code: 'custom',
        message: 'A terminal AgentRun must have finishedAt',
        path: ['finishedAt'],
      })
    }

    if (!isTerminal && run.finishedAt !== null) {
      context.addIssue({
        code: 'custom',
        message: 'A non-terminal AgentRun cannot have finishedAt',
        path: ['finishedAt'],
      })
    }

    if (run.status === 'QUEUED' && run.startedAt !== null) {
      context.addIssue({
        code: 'custom',
        message: 'A queued AgentRun cannot have startedAt',
        path: ['startedAt'],
      })
    }

    if (run.retryOfRunId === run.id) {
      context.addIssue({
        code: 'custom',
        message: 'An AgentRun cannot retry itself',
        path: ['retryOfRunId'],
      })
    }
  })

export type AgentRunDto = z.infer<typeof agentRunDtoSchema>
