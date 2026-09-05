import type { LearningGoalResponse } from '@knowledgeops/contracts'
import { BadRequestException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'

import type { CreateLearningGoalService } from '../src/learning-goals/create-learning-goal.service.js'
import { LearningGoalController } from '../src/learning-goals/learning-goal.controller.js'
import { InvalidLearningGoalInputError } from '../src/learning-goals/learning-goal.errors.js'

describe('LearningGoalController', () => {
  const actor = {
    userId: '00000000-0000-4000-8000-000000000001',
    timezone: 'Asia/Shanghai',
  }

  it('delegates unknown HTTP input with the trusted actor context', async () => {
    const response: LearningGoalResponse = {
      id: 'fedfb2e2-8f0e-4830-8240-f198cecabd95',
      title: 'Frontend interviews',
      currentLevel: 'Comfortable with Vue 3',
      deadline: '2026-09-20',
      weeklyMinutes: 600,
      createdAt: '2026-09-04T08:00:00.000Z',
    }
    const execute = vi.fn().mockResolvedValue(response)
    const service = { execute } as unknown as CreateLearningGoalService
    const controller = new LearningGoalController(service, actor)
    const input = {
      title: response.title,
      currentLevel: response.currentLevel,
      deadline: response.deadline,
      weeklyMinutes: response.weeklyMinutes,
    }

    await expect(controller.create(input)).resolves.toEqual(response)
    expect(execute).toHaveBeenCalledWith({
      actorUserId: actor.userId,
      actorTimezone: actor.timezone,
      input,
    })
  })

  it('maps runtime validation issues to a stable 400 response', async () => {
    const execute = vi
      .fn()
      .mockRejectedValue(
        new InvalidLearningGoalInputError([
          { message: 'deadline is outside the allowed range', path: ['deadline'] },
        ]),
      )
    const controller = new LearningGoalController(
      { execute } as unknown as CreateLearningGoalService,
      actor,
    )

    await expect(controller.create({})).rejects.toMatchObject({
      constructor: BadRequestException,
      response: {
        code: 'VALIDATION_ERROR',
        issues: [{ message: 'deadline is outside the allowed range', path: ['deadline'] }],
      },
    })
  })
})
