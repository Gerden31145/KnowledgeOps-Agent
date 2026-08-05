import {
  AGENT_RUN_KINDS,
  AGENT_RUN_STATES,
  TASK_STATES,
} from '../../packages/contracts/src/index.js'
import {
  AgentRunKind as PrismaAgentRunKind,
  AgentRunState as PrismaAgentRunState,
  TaskState as PrismaTaskState,
} from '../../generated/prisma/enums.js'
import { describe, expect, it } from 'vitest'

describe('persistence enum drift', () => {
  it('keeps Task states aligned between the transport contract and Prisma', () => {
    expect(Object.values(PrismaTaskState)).toEqual(TASK_STATES)
  })

  it('keeps AgentRun kinds and states aligned between contracts and Prisma', () => {
    expect(Object.values(PrismaAgentRunKind)).toEqual(AGENT_RUN_KINDS)
    expect(Object.values(PrismaAgentRunState)).toEqual(AGENT_RUN_STATES)
  })
})
