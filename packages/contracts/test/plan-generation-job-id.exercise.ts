import { buildPlanGenerationJobId } from '../src/index.js'
import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'

describe('stable plan generation Job ID boundary cases', () => {
  it('同一个合法 `generationRunId` 多次调用得到完全相同的 Job ID', () => {
    const runId = randomUUID()
    const targetJobId = buildPlanGenerationJobId(runId)
    for (let i = 0; i < 50; i++) {
      const generatedJobId = buildPlanGenerationJobId(runId)
      expect(generatedJobId).toBe(targetJobId)
    }
  })

  it('不同运行 ID 得到不同 Job ID', () => {
    const runId1 = randomUUID()
    const runId2 = randomUUID()
    const jobId1 = buildPlanGenerationJobId(runId1)
    const jobId2 = buildPlanGenerationJobId(runId2)
    expect(jobId1).not.toBe(jobId2)
  })

  it('结果使用约定前缀和连字符，且不包含冒号', () => {
    const runId = randomUUID()
    const targetJobId = buildPlanGenerationJobId(runId)
    const isValid = targetJobId.startsWith('plan-generation-')
    const noColon = targetJobId.indexOf(':') === -1
    expect(noColon).toBe(true)
    expect(isValid).toBe(true)
  })

  it('非法实体 ID 会在生成 Job ID 时被拒绝，而不是生成一个看似合法的队列键', () => {
    const inValidID = '#$@'
    expect(() => buildPlanGenerationJobId(inValidID)).toThrow()
  })
})
