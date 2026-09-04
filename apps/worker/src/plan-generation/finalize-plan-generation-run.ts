import type { PlanGenerationOutput } from '@knowledgeops/agent-core'
import type { PlanGenerationRunState } from '@knowledgeops/contracts'
import type { DatabaseClient } from '@knowledgeops/database'

export interface FinalizePlanGenerationRunCommand {
  candidate: PlanGenerationOutput
  expectedRunVersion: number
  finishedAt: Date
  generationRunId: string
  goalId: string
}

export type FinalizePlanGenerationRunResult =
  | {
      status: 'FINALIZED'
      planId: string
    }
  | {
      status: 'SKIPPED'
      planId: string | null
      runStatus: PlanGenerationRunState
    }

export interface PlanGenerationSuccessFinalizer {
  execute(command: FinalizePlanGenerationRunCommand): Promise<FinalizePlanGenerationRunResult>
}

export const PLAN_GENERATION_SUCCESS_FINALIZER = Symbol('PLAN_GENERATION_SUCCESS_FINALIZER')

export class PlanGenerationSuccessFinalizerNotImplementedError extends Error {
  override readonly name = 'PlanGenerationSuccessFinalizerNotImplementedError'

  constructor() {
    super('Stage 2 core handwrite: atomic plan generation finalizer is not implemented yet')
  }
}

/**
 * The interface and black-box acceptance are prepared on day 08-10. The
 * transaction body remains the independent Stage 2 core handwrite task.
 */
export class FinalizePlanGenerationRun implements PlanGenerationSuccessFinalizer {
  constructor(private readonly _database: DatabaseClient) {}

  async execute(
    _command: FinalizePlanGenerationRunCommand,
  ): Promise<FinalizePlanGenerationRunResult> {
    void _command
    throw new PlanGenerationSuccessFinalizerNotImplementedError()
  }
}
