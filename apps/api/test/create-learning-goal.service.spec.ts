import type { LearningGoalResponse } from '@knowledgeops/contracts'
import { describe, expect, it, vi } from 'vitest'

import { CreateLearningGoalService } from '../src/learning-goals/create-learning-goal.service.js'
import { InvalidLearningGoalInputError } from '../src/learning-goals/learning-goal.errors.js'
import type { LearningGoalRepository } from '../src/learning-goals/learning-goal.repository.js'

describe('CreateLearningGoalService', () => {
  const createdAt = new Date('2026-09-04T16:30:00.000Z')

  it('validates the date against the actor timezone and persists normalized input', async () => {
    const response: LearningGoalResponse = {
      id: 'fedfb2e2-8f0e-4830-8240-f198cecabd95',
      title: 'Frontend interviews',
      currentLevel: 'Comfortable with Vue 3',
      deadline: '2026-09-06',
      weeklyMinutes: 600,
      createdAt: createdAt.toISOString(),
    }
    const create = vi.fn().mockResolvedValue(response)
    const repository = { create } as unknown as LearningGoalRepository
    const service = new CreateLearningGoalService(repository, () => createdAt)

    await expect(
      service.execute({
        actorUserId: '00000000-0000-4000-8000-000000000001',
        actorTimezone: 'Asia/Shanghai',
        input: {
          title: '  Frontend interviews  ',
          currentLevel: '  Comfortable with Vue 3  ',
          deadline: '2026-09-06',
          weeklyMinutes: 600,
        },
      }),
    ).resolves.toEqual(response)
    expect(create).toHaveBeenCalledWith({
      actorUserId: '00000000-0000-4000-8000-000000000001',
      actorTimezone: 'Asia/Shanghai',
      input: {
        title: 'Frontend interviews',
        currentLevel: 'Comfortable with Vue 3',
        deadline: '2026-09-06',
        weeklyMinutes: 600,
      },
      createdAt,
    })
  })

  it('rejects a deadline that is not after the actor local date', async () => {
    const create = vi.fn()
    const repository = { create } as unknown as LearningGoalRepository
    const service = new CreateLearningGoalService(repository, () => createdAt)

    await expect(
      service.execute({
        actorUserId: '00000000-0000-4000-8000-000000000001',
        actorTimezone: 'Asia/Shanghai',
        input: {
          title: 'Frontend interviews',
          currentLevel: 'Comfortable with Vue 3',
          deadline: '2026-09-05',
          weeklyMinutes: 600,
        },
      }),
    ).rejects.toBeInstanceOf(InvalidLearningGoalInputError)
    expect(create).not.toHaveBeenCalled()
  })
})
