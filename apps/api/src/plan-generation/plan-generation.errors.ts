export class LearningGoalNotFoundError extends Error {
  constructor() {
    super('Learning goal was not found for the current user')
    this.name = 'LearningGoalNotFoundError'
  }
}

export class UnknownPlanGenerationModelError extends Error {
  constructor(readonly modelId: string) {
    super(`Model is not available: ${modelId}`)
    this.name = 'UnknownPlanGenerationModelError'
  }
}

export class ActivePlanGenerationRunError extends Error {
  constructor(readonly generationRunId: string) {
    super('This learning goal already has an active plan generation run')
    this.name = 'ActivePlanGenerationRunError'
  }
}

export class InvalidPlanGenerationRetryError extends Error {
  constructor() {
    super('Retry source must be a failed or timed-out run for the same learning goal')
    this.name = 'InvalidPlanGenerationRetryError'
  }
}

export class PlanGenerationRunNotFoundError extends Error {
  constructor() {
    super('Plan generation run was not found for the current user')
    this.name = 'PlanGenerationRunNotFoundError'
  }
}
