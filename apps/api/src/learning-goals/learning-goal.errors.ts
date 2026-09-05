export class InvalidLearningGoalInputError extends Error {
  override readonly name = 'InvalidLearningGoalInputError'

  constructor(readonly issues: ReadonlyArray<{ message: string; path: PropertyKey[] }>) {
    super('Learning goal input is invalid')
  }
}
