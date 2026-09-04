import {
  ACCEPTANCE_CRITERION_TYPES,
  AGENT_RUN_KINDS,
  AGENT_RUN_STATES,
  OUTBOX_EVENT_TYPES,
  PLAN_GENERATION_RUN_STATES,
  PLAN_STATUSES,
  TASK_TYPES,
  TASK_STATES,
} from '../../packages/contracts/src/index.js'
import {
  AcceptanceCriterionType as PrismaAcceptanceCriterionType,
  AgentRunKind as PrismaAgentRunKind,
  AgentRunState as PrismaAgentRunState,
  OutboxEventType as PrismaOutboxEventType,
  PlanGenerationRunState as PrismaPlanGenerationRunState,
  PlanStatus as PrismaPlanStatus,
  TaskType as PrismaTaskType,
  TaskState as PrismaTaskState,
} from '../../packages/database/src/generated/prisma/enums.js'
import { describe, expect, it } from 'vitest'

describe('persistence enum drift', () => {
  it('keeps Task states aligned between the transport contract and Prisma', () => {
    expect(Object.values(PrismaTaskState)).toEqual(TASK_STATES)
  })

  it('keeps AgentRun kinds and states aligned between contracts and Prisma', () => {
    expect(Object.values(PrismaAgentRunKind)).toEqual(AGENT_RUN_KINDS)
    expect(Object.values(PrismaAgentRunState)).toEqual(AGENT_RUN_STATES)
  })

  it('keeps plan generation and outbox enums aligned with persistence', () => {
    expect(Object.values(PrismaPlanGenerationRunState)).toEqual(PLAN_GENERATION_RUN_STATES)
    expect(Object.values(PrismaOutboxEventType)).toEqual(OUTBOX_EVENT_TYPES)
  })

  it('keeps Plan states aligned between the transport contract and Prisma', () => {
    expect(Object.values(PrismaPlanStatus)).toEqual(PLAN_STATUSES)
  })

  it('keeps plan task and criterion enums aligned with persistence', () => {
    expect(Object.values(PrismaTaskType)).toEqual(TASK_TYPES)
    expect(Object.values(PrismaAcceptanceCriterionType)).toEqual(ACCEPTANCE_CRITERION_TYPES)
  })
})
