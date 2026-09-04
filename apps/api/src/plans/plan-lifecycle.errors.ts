export class PlanNotFoundError extends Error {
  constructor() {
    super('Plan was not found for the current user')
    this.name = 'PlanNotFoundError'
  }
}

export class TaskNotFoundError extends Error {
  constructor() {
    super('Task was not found for the current user')
    this.name = 'TaskNotFoundError'
  }
}

export class InvalidPlanLifecycleStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidPlanLifecycleStateError'
  }
}

export class AnotherActivePlanError extends Error {
  constructor(readonly activePlanId: string) {
    super('Another plan is already active for this user')
    this.name = 'AnotherActivePlanError'
  }
}

export class AnotherTaskInProgressError extends Error {
  constructor(readonly activeTaskId: string) {
    super('Another task is already in progress or waiting for verification')
    this.name = 'AnotherTaskInProgressError'
  }
}

export class TaskTargetPathRequiredError extends Error {
  constructor() {
    super('A repository-relative Markdown target path is required before starting the task')
    this.name = 'TaskTargetPathRequiredError'
  }
}

export class TaskTargetPathConflictError extends Error {
  constructor() {
    super('An already-started task cannot be restarted with a different target path')
    this.name = 'TaskTargetPathConflictError'
  }
}
