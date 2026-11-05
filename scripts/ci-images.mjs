// CD02 metadata only. Docker orchestration remains visible in the workflow/smoke script.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  constants,
  copyFileSync,
  mkdirSync,
  readFileSync,
  appendFileSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const services = ['api', 'worker', 'web', 'migrate']
const digestPattern = /^sha256:[a-f\d]{64}$/

export function imagePlan({ repository, commit, runId, attempt }) {
  assert.match(repository, /^[A-Za-z\d_.-]+\/[A-Za-z\d_.-]+$/)
  assert.match(commit, /^[a-f\d]{40}$/)
  assert.match(runId, /^[1-9]\d*$/)
  assert.match(attempt, /^[1-9]\d*$/)
  const prefix = `ghcr.io/${repository.toLowerCase()}`
  const tag = `sha-${commit}-run-${runId}-${attempt}`
  return {
    repository,
    commit,
    runId,
    attempt,
    images: Object.fromEntries(services.map((service) => [service, `${prefix}/${service}:${tag}`])),
  }
}

export function assertVerifiedImages(plan, snapshot, currentImages, smoke) {
  assert.deepEqual(snapshot.source, plan, 'Build record belongs to another commit/run/attempt')
  assert.equal(smoke.event, 'cd02-smoke-verified')
  assert.equal(smoke.commit, plan.commit)
  assert.equal(smoke.runId, plan.runId)
  assert.equal(smoke.attempt, plan.attempt)
  for (const result of [smoke.before, smoke.after]) {
    assert.equal(result?.event, 'cd01-verified')
    assert.equal(result.status, 'SUCCEEDED')
    assert.equal(result.tasks, 3)
    assert.match(result.runId, /^[a-f\d-]{36}$/i)
    assert.match(result.planId, /^[a-f\d-]{36}$/i)
  }
  assert.equal(smoke.before.runId, smoke.after.runId, 'Recreation must check the same Run')
  assert.equal(smoke.before.planId, smoke.after.planId, 'Recreation must preserve the same Plan')
  for (const service of services) {
    assert.match(snapshot.images[service]?.Id ?? '', digestPattern)
    assert.equal(
      currentImages[service]?.Id,
      snapshot.images[service].Id,
      `${service} changed after build`,
    )
    assert.equal(currentImages[service].Os, 'linux')
    assert.equal(currentImages[service].Architecture, 'amd64')
  }
}

export function digestReference(tag, repoDigests) {
  const repository = tag.slice(0, tag.lastIndexOf(':'))
  const matches = (repoDigests ?? []).filter((value) => value.startsWith(`${repository}@`))
  assert.equal(matches.length, 1, `Expected one registry digest for ${repository}`)
  const digest = matches[0].slice(repository.length + 1)
  assert.match(digest, digestPattern)
  return { digest, reference: matches[0] }
}

function run() {
  const env = process.env
  assert.equal(env.GITHUB_ACTIONS, 'true', 'Run this entry in GitHub Actions')
  assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted', 'Use the disposable hosted runner')
  assert.equal(env.GITHUB_REF, 'refs/heads/main')
  assert.ok(['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME))
  assert.equal(env.QUALITY_RESULT, 'success')
  assert.equal(env.REGRESSION_RESULT, 'success')
  const plan = imagePlan({
    repository: env.GITHUB_REPOSITORY,
    commit: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT,
  })
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), plan.commit)
  const snapshotPath = join(env.RUNNER_TEMP, 'cd02-images.json')
  const smokePath = join(env.RUNNER_TEMP, 'cd02-smoke.json')
  const dockerJson = (args) => JSON.parse(execFileSync('docker', args, { encoding: 'utf8' }))
  const inspect = () =>
    Object.fromEntries(
      services.map((service) => [
        service,
        dockerJson(['image', 'inspect', plan.images[service]])[0],
      ]),
    )
  const writeJson = (path, data) => writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`)
  const action = process.argv[2]

  if (action === 'prepare') {
    copyFileSync('deploy/cd01.env.example', 'deploy/.env.cd01', constants.COPYFILE_EXCL)
    const variables = [
      `COMPOSE_PROJECT_NAME=knowledgeops-ci-${plan.runId}-${plan.attempt}`,
      ...services.map((service) => `${service.toUpperCase()}_IMAGE=${plan.images[service]}`),
      'DOCKER_DEFAULT_PLATFORM=linux/amd64',
    ]
    appendFileSync(env.GITHUB_ENV, `${variables.join('\n')}\n`)
  } else if (action === 'snapshot') {
    writeJson(snapshotPath, { source: plan, images: inspect() })
  } else if (action === 'publish') {
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'))
    const smoke = JSON.parse(readFileSync(smokePath, 'utf8'))
    assertVerifiedImages(plan, snapshot, inspect(), smoke)
    const images = {}
    for (const service of services) {
      const tag = plan.images[service]
      execFileSync('docker', ['push', tag], { stdio: 'inherit' })
      const pushed = dockerJson(['image', 'inspect', tag])[0]
      assert.equal(pushed.Id, snapshot.images[service].Id)
      images[service] = { tag, imageId: pushed.Id, ...digestReference(tag, pushed.RepoDigests) }
    }
    const releaseDirectory = join(env.RUNNER_TEMP, 'cd02-release')
    mkdirSync(releaseDirectory)
    const workflowUrl = `https://github.com/${plan.repository}/actions/runs/${plan.runId}/attempts/${plan.attempt}`
    writeJson(join(releaseDirectory, 'release.json'), {
      schemaVersion: 1,
      repository: plan.repository,
      commit: plan.commit,
      workflow: {
        name: env.GITHUB_WORKFLOW,
        runId: plan.runId,
        attempt: plan.attempt,
        url: workflowUrl,
      },
      platform: 'linux/amd64',
      checks: {
        quality: env.QUALITY_RESULT,
        regression: env.REGRESSION_RESULT,
        containers: 'success',
      },
      smoke,
      images,
    })
    writeFileSync(
      join(releaseDirectory, 'images.env'),
      `${services.map((service) => `${service.toUpperCase()}_IMAGE=${images[service].reference}`).join('\n')}\n`,
    )
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `## Verified container release\n\nCommit: \`${plan.commit}\` · [CI run](${workflowUrl})\n\n` +
        services.map((service) => `- ${service}: \`${images[service].reference}\``).join('\n') +
        '\n\nDownload the release artifact to obtain release.json and images.env. Production deployment is a separate manual workflow (CD03).\n',
    )
  } else {
    throw new Error('Usage: node scripts/ci-images.mjs prepare|snapshot|publish')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run()
