import { planGenerationOutputSchema } from '../../packages/agent-core/src/index.js'
import { describe, expect, it } from 'vitest'

import {
  assertVerifiedImages,
  digestReference,
  imagePlan,
  mapWithConcurrency,
  services,
} from '../../scripts/ci-images.mjs'
import { plan as containerPlan } from './cd01-model.mjs'

const context = {
  repository: 'Gerden31145/KnowledgeOps-Agent',
  commit: 'a'.repeat(40),
  runId: '123',
  attempt: '1',
}
const digest = `sha256:${'b'.repeat(64)}`

function fixture() {
  const plan = imagePlan(context)
  const images = Object.fromEntries(
    services.map((service) => [
      service,
      {
        Id: digest,
        Os: 'linux',
        Architecture: 'amd64',
      },
    ]),
  )
  const result = {
    event: 'cd01-verified',
    status: 'SUCCEEDED',
    tasks: 3,
    runId: '0f924b25-adbb-4a26-9c02-bd605c4573cf',
    planId: 'a9b540d8-b9b2-4e7b-bc2b-633e066ebff5',
  }
  return {
    plan,
    images,
    snapshot: { source: plan, images: structuredClone(images) },
    smoke: {
      event: 'cd02-smoke-verified',
      commit: context.commit,
      runId: context.runId,
      attempt: context.attempt,
      before: result,
      after: structuredClone(result),
    },
  }
}

describe('CD02 verified image delivery', () => {
  it('keeps the container model response on the current course contract', () => {
    expect(planGenerationOutputSchema.parse(containerPlan)).toEqual(containerPlan)
    expect(
      containerPlan.stages.flatMap((stage) => stage.tasks).every((task) => task.type === 'COURSE'),
    ).toBe(true)
  })

  it('uses lowercase registry names and separates workflow reruns of the same commit', () => {
    expect(imagePlan(context).images.api).toBe(
      `ghcr.io/gerden31145/knowledgeops-agent/api:sha-${context.commit}-run-123-1`,
    )
    expect(imagePlan({ ...context, attempt: '2' }).images.api).not.toBe(
      imagePlan(context).images.api,
    )
    expect(() => imagePlan({ ...context, commit: 'main' })).toThrow()
  })

  it('accepts the exact image set and preserved Run/Plan', () => {
    const f = fixture()
    expect(() => assertVerifiedImages(f.plan, f.snapshot, f.images, f.smoke)).not.toThrow()
  })

  it('rejects a replaced image even when its tag has not changed', () => {
    const f = fixture()
    f.images.worker.Id = `sha256:${'c'.repeat(64)}`
    expect(() => assertVerifiedImages(f.plan, f.snapshot, f.images, f.smoke)).toThrow(
      /worker changed/,
    )
  })

  it('rejects a receipt from another workflow attempt or a new Plan after recreation', () => {
    const f = fixture()
    f.smoke.attempt = '2'
    expect(() => assertVerifiedImages(f.plan, f.snapshot, f.images, f.smoke)).toThrow()
    f.smoke.attempt = '1'
    f.smoke.after.planId = 'b9b540d8-b9b2-4e7b-bc2b-633e066ebff5'
    expect(() => assertVerifiedImages(f.plan, f.snapshot, f.images, f.smoke)).toThrow(/same Plan/)
  })

  it('rejects a failed result or an incompatible architecture', () => {
    const f = fixture()
    f.smoke.after.status = 'FAILED'
    expect(() => assertVerifiedImages(f.plan, f.snapshot, f.images, f.smoke)).toThrow()
    f.smoke.after.status = 'SUCCEEDED'
    f.images.web.Architecture = 'arm64'
    expect(() => assertVerifiedImages(f.plan, f.snapshot, f.images, f.smoke)).toThrow()
  })

  it('records a digest for the correct registry repository, never a mutable tag', () => {
    const tag = imagePlan(context).images.api
    const reference = `ghcr.io/gerden31145/knowledgeops-agent/api@${digest}`
    expect(digestReference(tag, [reference])).toEqual({ digest, reference })
    expect(() => digestReference(tag, [`ghcr.io/another/repo@${digest}`])).toThrow()
    expect(() =>
      digestReference(tag, ['ghcr.io/gerden31145/knowledgeops-agent/api@latest']),
    ).toThrow()
  })

  it('bounds concurrent pushes and preserves release record service order', async () => {
    let active = 0
    let maximum = 0
    const results = await mapWithConcurrency(services, 2, async (service) => {
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise((resolve) => setTimeout(resolve, service === 'api' ? 20 : 1))
      active -= 1
      return service.toUpperCase()
    })
    expect(maximum).toBe(2)
    expect(results).toEqual(['API', 'WORKER', 'WEB', 'MIGRATE'])
  })

  it('stops assigning pushes after a failure and waits for in-flight work', async () => {
    const started = []
    let finished = false
    const publishing = mapWithConcurrency(services, 2, async (service) => {
      started.push(service)
      if (service === 'api') throw new Error('push failed')
      await new Promise((resolve) => setTimeout(resolve, 10))
      finished = true
    })
    await expect(publishing).rejects.toThrow('push failed')
    expect(started).toEqual(['api', 'worker'])
    expect(finished).toBe(true)
  })
})
