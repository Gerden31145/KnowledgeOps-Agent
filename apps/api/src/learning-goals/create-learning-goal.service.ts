import { createLearningGoalInputSchema, type LearningGoalResponse } from '@knowledgeops/contracts'

import { InvalidLearningGoalInputError } from './learning-goal.errors.js'
import { LearningGoalRepository } from './learning-goal.repository.js'

export interface CreateLearningGoalRequest {
  actorUserId: string
  actorTimezone: string
  input: unknown
}

type Clock = () => Date

export class CreateLearningGoalService {
  constructor(
    private readonly repository: LearningGoalRepository,
    private readonly clock: Clock = () => new Date(),
  ) {}

  async execute(request: CreateLearningGoalRequest): Promise<LearningGoalResponse> {
    const createdAt = this.clock()
    const today = formatDateInTimeZone(createdAt, request.actorTimezone)
    const parsedInput = createLearningGoalInputSchema(today).safeParse(request.input)

    if (!parsedInput.success) {
      throw new InvalidLearningGoalInputError(parsedInput.error.issues)
    }

    return this.repository.create({
      actorUserId: request.actorUserId,
      actorTimezone: request.actorTimezone,
      input: parsedInput.data,
      createdAt,
    })
  }
}

function formatDateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))

  return `${values.year}-${values.month}-${values.day}`
}
