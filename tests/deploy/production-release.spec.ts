import { describe, expect, it } from 'vitest'
import { imagePlan, services } from '../../scripts/ci-images.mjs'
import { validateJobs, validateRelease, validateRun } from '../../scripts/release-record.mjs'
import {
  assertRollback,
  prepareRuntime,
  runSteps,
  validatePulledImage,
} from '../../scripts/production-release.mjs'

const selected = { commit: 'a'.repeat(40), runId: '1234', attempt: '1' }
function recordFixture() {
  const repository = 'Gerden31145/KnowledgeOps-Agent'
  const plan = imagePlan({ repository, ...selected })
  const result = {
    event: 'cd01-verified',
    status: 'SUCCEEDED',
    tasks: 3,
    runId: '0f924b25-adbb-4a26-9c02-bd605c4573cf',
    planId: 'a9b540d8-b9b2-4e7b-bc2b-633e066ebff5',
  }
  return {
    schemaVersion: 1,
    repository,
    commit: selected.commit,
    platform: 'linux/amd64',
    workflow: {
      name: 'CI',
      runId: selected.runId,
      attempt: selected.attempt,
      url: `https://github.com/${repository}/actions/runs/1234/attempts/1`,
    },
    checks: { quality: 'success', regression: 'success', containers: 'success' },
    smoke: {
      event: 'cd02-smoke-verified',
      ...selected,
      before: result,
      after: structuredClone(result),
    },
    images: Object.fromEntries(
      services.map((service, i) => {
        const digest = `sha256:${String(i).repeat(64)}`
        return [
          service,
          {
            tag: plan.images[service],
            imageId: `sha256:${'b'.repeat(64)}`,
            digest,
            reference: `ghcr.io/${repository.toLowerCase()}/${service}@${digest}`,
          },
        ]
      }),
    ),
  }
}
function runFixture() {
  return {
    id: 1234,
    run_attempt: 1,
    head_sha: selected.commit,
    head_branch: 'main',
    repository: { full_name: 'Gerden31145/KnowledgeOps-Agent' },
    head_repository: { full_name: 'Gerden31145/KnowledgeOps-Agent' },
    path: '.github/workflows/ci.yml',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
  }
}
function environment() {
  return {
    DATABASE_URL: 'postgresql://app:p%40ss@127.0.0.1:15432/knowledgeops?schema=public',
    REDIS_URL: 'redis://127.0.0.1:16379',
    WEB_ORIGIN: 'https://knowops.site',
    NUXT_PUBLIC_API_BASE_URL: 'https://api.knowops.site',
    GITHUB_APP_CALLBACK_URL: 'https://api.knowops.site/auth/github/callback',
    GITHUB_APP_CLIENT_ID: 'synthetic',
    GITHUB_APP_CLIENT_SECRET: 'synthetic-$-secret',
    GITHUB_WEBHOOK_SECRET: 'synthetic-webhook',
    GITHUB_APP_PRIVATE_KEY_PATH: '/synthetic/app.pem',
    OPENAI_API_KEY: 'synthetic',
    NOTE_VERIFICATION_MODEL_JSON: '{"modelName":"fixture"}',
  }
}

describe('CD03 image identity across Docker stores', () => {
  function pulled() {
    const expected = recordFixture().images.api
    return {
      expected,
      actual: {
        Id: expected.imageId,
        RepoDigests: [expected.reference],
        Os: 'linux',
        Architecture: 'amd64',
      },
    }
  }

  it.each(['classic', 'containerd'])(
    'accepts the exact repository digest with a %s local ID',
    (backend) => {
      const { expected, actual } = pulled()
      actual.Id = backend === 'classic' ? expected.imageId : expected.digest
      expect(() => validatePulledImage(expected, actual)).not.toThrow()
    },
  )

  it('rejects another registry digest even when the local ID matches the CI image ID', () => {
    const { expected, actual } = pulled()
    actual.RepoDigests = [expected.reference.replace(expected.digest, `sha256:${'f'.repeat(64)}`)]
    expect(() => validatePulledImage(expected, actual)).toThrow('verified repository digest')
  })

  it('rejects the same digest under a different repository', () => {
    const { expected, actual } = pulled()
    actual.RepoDigests = [`ghcr.io/another/repository@${expected.digest}`]
    expect(() => validatePulledImage(expected, actual)).toThrow('verified repository digest')
  })

  it('rejects absent or empty repository digests', () => {
    const { expected, actual } = pulled()
    for (const RepoDigests of [undefined, null, []]) {
      expect(() => validatePulledImage(expected, { ...actual, RepoDigests })).toThrow(
        'verified repository digest',
      )
    }
  })

  it.each([{ Os: 'windows' }, { Architecture: 'arm64' }])(
    'rejects the wrong platform %j',
    (platform) => {
      const { expected, actual } = pulled()
      expect(() => validatePulledImage(expected, { ...actual, ...platform })).toThrow()
    },
  )
})

describe('CD03 release selection and failure boundaries', () => {
  it('derives all four immutable image references from the complete verified record', () => {
    const record = recordFixture()
    const result = validateRelease(record)
    expect(result.trim().split('\n')).toHaveLength(4)
    expect(result).toContain(`WORKER_IMAGE=${record.images.worker.reference}\n`)
  })
  it('rejects mixed commits, foreign registry references, missing images and different recovered data', () => {
    for (const mutate of [
      (r: ReturnType<typeof recordFixture>) => {
        r.images.api.tag = 'latest'
      },
      (r: ReturnType<typeof recordFixture>) => {
        r.images.web.reference = 'ghcr.io/someone/other@' + r.images.web.digest
      },
      (r: ReturnType<typeof recordFixture>) => {
        delete r.images.migrate
      },
      (r: ReturnType<typeof recordFixture>) => {
        r.smoke.after.planId = 'b'.repeat(36)
      },
    ]) {
      const record = recordFixture()
      mutate(record)
      expect(() => validateRelease(record)).toThrow()
    }
  })
  it('requires an actual successful main CI run and its exact latest attempt', () => {
    expect(() => validateRun(runFixture(), selected)).not.toThrow()
    for (const patch of [
      { conclusion: 'failure' },
      { status: 'in_progress' },
      { run_attempt: 2 },
      { event: 'pull_request' },
      { head_branch: 'feature' },
      { head_sha: 'c'.repeat(40) },
      { path: '.github/workflows/other.yml' },
      { head_repository: { full_name: 'someone/fork' } },
    ]) {
      expect(() => validateRun({ ...runFixture(), ...patch }, selected)).toThrow()
    }
  })
  it('does not accept overall success when a required job was skipped or belongs to another attempt', () => {
    const jobs = [
      'Quality and build',
      'Core reliability and browser flows',
      'Verify and publish container images',
    ].map((name) => ({
      name,
      head_sha: selected.commit,
      run_id: 1234,
      run_attempt: 1,
      status: 'completed',
      conclusion: 'success',
    }))
    expect(() => validateJobs(jobs, selected)).not.toThrow()
    jobs[2]!.conclusion = 'skipped'
    expect(() => validateJobs(jobs, selected)).toThrow()
    jobs[2]!.conclusion = 'success'
    jobs[2]!.run_attempt = 2
    expect(() => validateJobs(jobs, selected)).toThrow()
  })
  it('rewrites only container endpoints while preserving credentials and structured model settings', () => {
    const source = environment()
    const { runtime, stopSeconds } = prepareRuntime(source)
    expect(runtime.DATABASE_URL).toBe(
      'postgresql://app:p%40ss@postgres:5432/knowledgeops?schema=public',
    )
    expect(runtime.REDIS_URL).toBe('redis://redis:6379')
    expect(runtime.GITHUB_APP_CLIENT_SECRET).toBe(source.GITHUB_APP_CLIENT_SECRET)
    expect(runtime.NOTE_VERIFICATION_MODEL_JSON).toBe(source.NOTE_VERIFICATION_MODEL_JSON)
    expect(runtime.GITHUB_APP_PRIVATE_KEY_PATH).toBe('/run/secrets/knowledgeops/github-app.pem')
    expect(source.DATABASE_URL).toContain('127.0.0.1:15432')
    expect(stopSeconds).toBe(210)
    expect(prepareRuntime({ ...source, NOTE_VERIFICATION_TIMEOUT_MS: '600000' }).stopSeconds).toBe(
      630,
    )
  })
  it('rejects an unexpected database, host-loopback proxy or multiline runtime value', () => {
    for (const patch of [
      { DATABASE_URL: 'postgresql://app:p@remote:5432/other' },
      { HTTPS_PROXY: 'http://127.0.0.1:7890' },
      { OPENAI_API_KEY: 'first\nOTHER=value' },
      { REDIS_URL: 'redis://password@127.0.0.1:16379' },
      { WEB_ORIGIN: 'https://game.gerden-shop.cn' },
      { NUXT_PUBLIC_API_BASE_URL: 'https://knowops.site/api' },
      { GITHUB_APP_CALLBACK_URL: 'https://game.gerden-shop.cn/api/auth/github/callback' },
    ]) {
      expect(() => prepareRuntime({ ...environment(), ...patch })).toThrow()
    }
  })
  it('requires a compatibility review, prior successful version and matching migration history for rollback', () => {
    const target = { migrationsDigest: 'a'.repeat(64) }
    expect(() => assertRollback(target, target, true)).not.toThrow()
    expect(() => assertRollback(target, target, false)).toThrow()
    expect(() => assertRollback(target, null, true)).toThrow()
    expect(() => assertRollback(target, { migrationsDigest: 'b'.repeat(64) }, true)).toThrow()
  })
  it.each(['preflight', 'backup', 'migrate', 'start-and-check'])(
    'stops at %s failure without activating or claiming success',
    async (failure) => {
      const visited: string[] = []
      const progress: { status: string; stage: string }[] = []
      const stages = [
        'preflight',
        'maintenance-and-stop',
        'backup',
        'migrate',
        'start-and-check',
        'activate',
      ]
      const steps = stages.map((stage) => [
        stage,
        () => {
          visited.push(stage)
          if (stage === failure) throw new Error('private provider/database details')
        },
      ])
      await expect(
        runSteps(steps, (value: { status: string; stage: string }) => progress.push(value)),
      ).rejects.toThrow(`Release stopped at ${failure}`)
      expect(visited).toEqual(stages.slice(0, stages.indexOf(failure) + 1))
      expect(progress.at(-1)).toEqual({ status: 'FAILED', stage: failure })
      expect(progress.some((p) => p.status === 'SUCCEEDED')).toBe(false)
    },
  )
  it('records success only after activation completes', async () => {
    let active = false
    const results: unknown[] = []
    await runSteps(
      [
        [
          'activate',
          () => {
            active = true
          },
        ],
      ],
      (value: { status: string }) => {
        if (value.status === 'SUCCEEDED') expect(active).toBe(true)
        results.push(value)
      },
    )
    expect(results.at(-1)).toEqual({ status: 'SUCCEEDED', stage: 'complete' })
  })
})
