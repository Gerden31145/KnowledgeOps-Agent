import { describe, expect, it, vi } from 'vitest'
import type { DatabaseClient } from '@knowledgeops/database'
import { PlanRepository } from '../src/plans/plan.repository.js'
import { PlanQueryService } from '../src/plans/plan-query.service.js'
import { PlanQueryController } from '../src/plans/plan-query.controller.js'

const userId = '11111111-1111-4111-8111-111111111111'
const planId = '22222222-2222-4222-8222-222222222222'
function fixture(active: unknown = null, goal: unknown = null) {
  const plan = { findFirst: vi.fn().mockResolvedValue(active) }
  const learningGoal = { findFirst: vi.fn().mockResolvedValue(goal) }
  const repository = new PlanRepository({ plan, learningGoal } as unknown as DatabaseClient)
  const controller = new PlanQueryController(new PlanQueryService(repository), {
    userId,
    timezone: 'Asia/Shanghai',
  })
  return { controller, plan, learningGoal }
}
describe('workspace entry', () => {
  it('prefers the owned active plan and does not choose a newer draft', async () => {
    const f = fixture({ id: planId })
    expect(await f.controller.getWorkspaceEntry()).toEqual({
      planId,
      runId: null,
      goal: null,
      modelId: null,
    })
    expect(f.plan.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'ACTIVE', goal: { userId } } }),
    )
    expect(f.learningGoal.findFirst).not.toHaveBeenCalled()
  })
  it('returns empty only after a successful owned query, propagating failures', async () => {
    const f = fixture()
    expect(await f.controller.getWorkspaceEntry()).toEqual({
      planId: null,
      runId: null,
      goal: null,
      modelId: null,
    })
    expect(f.learningGoal.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId } }),
    )
    f.plan.findFirst.mockRejectedValueOnce(new Error('database unavailable'))
    await expect(f.controller.getWorkspaceEntry()).rejects.toThrow('database unavailable')
  })
  it('recovers the newest run and its original goal, including a saved goal with no run', async () => {
    const goal = {
      id: userId,
      title: '异步机制',
      currentLevel: '掌握语法',
      deadline: new Date('2027-01-01'),
      weeklyMinutes: 300,
      plans: [],
      planGenerationRuns: [{ id: planId, modelCatalogId: 'model-a' }],
    }
    const f = fixture(null, goal)
    expect(await f.controller.getWorkspaceEntry()).toMatchObject({
      runId: planId,
      planId: null,
      modelId: 'model-a',
      goal: { deadline: '2027-01-01' },
    })
    f.learningGoal.findFirst.mockResolvedValueOnce({ ...goal, planGenerationRuns: [] })
    expect(await f.controller.getWorkspaceEntry()).toMatchObject({
      runId: null,
      planId: null,
      goal: { id: userId },
    })
  })
})
