import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertVerifiedImages, imagePlan, services } from './ci-images.mjs'

export const repository = 'Gerden31145/KnowledgeOps-Agent'

export function validateRelease(record) {
  assert.equal(record.schemaVersion, 1)
  assert.equal(record.repository, repository)
  assert.equal(record.platform, 'linux/amd64')
  assert.equal(record.workflow.name, 'CI')
  const plan = imagePlan({
    repository,
    commit: record.commit,
    runId: record.workflow.runId,
    attempt: record.workflow.attempt,
  })
  assert.equal(
    record.workflow.url,
    `https://github.com/${repository}/actions/runs/${plan.runId}/attempts/${plan.attempt}`,
  )
  assert.deepEqual(record.checks, {
    quality: 'success',
    regression: 'success',
    containers: 'success',
  })
  assert.deepEqual(Object.keys(record.images).sort(), [...services].sort())
  const images = {}
  for (const service of services) {
    const image = record.images[service]
    assert.match(image.digest, /^sha256:[a-f\d]{64}$/)
    assert.equal(image.tag, plan.images[service])
    assert.equal(image.reference, `ghcr.io/${repository.toLowerCase()}/${service}@${image.digest}`)
    images[service] = { Id: image.imageId, Os: 'linux', Architecture: 'amd64' }
  }
  assertVerifiedImages(plan, { source: plan, images }, images, record.smoke)
  return (
    services
      .map((service) => `${service.toUpperCase()}_IMAGE=${record.images[service].reference}`)
      .join('\n') + '\n'
  )
}

export function validateRun(run, selected) {
  assert.match(selected.commit, /^[a-f\d]{40}$/)
  for (const name of ['runId', 'attempt']) assert.match(selected[name], /^[1-9]\d*$/)
  assert.equal(String(run.id), selected.runId)
  assert.equal(String(run.run_attempt), selected.attempt, 'Select the current successful attempt')
  assert.equal(run.head_sha, selected.commit)
  assert.equal(run.head_branch, 'main')
  assert.equal(run.repository.full_name, repository)
  assert.equal(run.head_repository.full_name, repository)
  assert.equal(run.path, '.github/workflows/ci.yml')
  assert.ok(['push', 'workflow_dispatch'].includes(run.event))
  assert.equal(run.status, 'completed')
  assert.equal(run.conclusion, 'success')
}

export function validateJobs(jobs, selected) {
  for (const name of [
    'Quality and build',
    'Core reliability and browser flows',
    'Verify and publish container images',
  ]) {
    const matching = jobs.filter((job) => job.name === name)
    assert.equal(matching.length, 1, `Missing or ambiguous job: ${name}`)
    const job = matching[0]
    assert.equal(job.head_sha, selected.commit)
    assert.equal(String(job.run_id), selected.runId)
    assert.equal(String(job.run_attempt), selected.attempt)
    assert.equal(job.status, 'completed')
    assert.equal(job.conclusion, 'success')
  }
}

export function treeDigest(directory) {
  const hash = createHash('sha256')
  function visit(relative) {
    for (const item of readdirSync(join(directory, relative), { withFileTypes: true }).sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    )) {
      const name = relative ? `${relative}/${item.name}` : item.name
      assert.ok(!item.isSymbolicLink(), 'Release inputs must not contain symlinks')
      if (item.isDirectory()) visit(name)
      else {
        assert.ok(item.isFile())
        hash.update(name + '\0')
        hash.update(readFileSync(join(directory, name)))
        hash.update('\0')
      }
    }
  }
  visit('')
  return hash.digest('hex')
}

async function download() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true')
  assert.equal(process.env.GITHUB_REPOSITORY, repository)
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main')
  const selected = {
    commit: process.env.RELEASE_COMMIT,
    runId: process.env.CI_RUN_ID,
    attempt: process.env.CI_ATTEMPT,
  }
  imagePlan({ repository, ...selected })
  const headers = {
    Authorization: `Bearer ${process.env.GH_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  const base = `https://api.github.com/repos/${repository}`
  async function api(path) {
    const response = await fetch(base + path, { headers, signal: AbortSignal.timeout(30_000) })
    assert.ok(response.ok, `GitHub API HTTP ${response.status}`)
    return response.json()
  }
  async function pages(path, key) {
    const result = []
    for (let page = 1; page <= 20; page++) {
      const values = (await api(`${path}?per_page=100&page=${page}`))[key]
      result.push(...values)
      if (values.length < 100) return result
    }
    throw new Error('Too many GitHub result pages')
  }
  validateRun(await api(`/actions/runs/${selected.runId}`), selected)
  validateJobs(
    await pages(`/actions/runs/${selected.runId}/attempts/${selected.attempt}/jobs`, 'jobs'),
    selected,
  )
  const name = `container-release-${selected.commit}-${selected.runId}-${selected.attempt}`
  const matches = (await pages(`/actions/runs/${selected.runId}/artifacts`, 'artifacts')).filter(
    (artifact) => artifact.name === name,
  )
  assert.equal(matches.length, 1, 'Expected the exact complete release artifact')
  const artifact = matches[0]
  assert.equal(artifact.expired, false)
  assert.ok(artifact.size_in_bytes > 0 && artifact.size_in_bytes < 262144)
  assert.match(artifact.digest, /^sha256:[a-f\d]{64}$/)
  const response = await fetch(`${base}/actions/artifacts/${artifact.id}/zip`, {
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  })
  assert.equal(response.status, 302)
  const location = new URL(response.headers.get('location'))
  assert.equal(location.protocol, 'https:')
  // The storage redirect must not receive the GitHub authorization header.
  const archiveResponse = await fetch(location, { signal: AbortSignal.timeout(30_000) })
  assert.ok(archiveResponse.ok)
  const archive = Buffer.from(await archiveResponse.arrayBuffer())
  assert.ok(archive.length < 262144)
  assert.equal(`sha256:${createHash('sha256').update(archive).digest('hex')}`, artifact.digest)
  const directory = join(process.env.RUNNER_TEMP, 'verified-release')
  mkdirSync(directory)
  const zip = join(directory, 'artifact.zip')
  writeFileSync(zip, archive)
  const unzip = (args) => execFileSync('unzip', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 })
  assert.deepEqual(unzip(['-Z1', zip]).trim().split('\n').sort(), ['images.env', 'release.json'])
  const record = JSON.parse(unzip(['-p', zip, 'release.json']))
  assert.equal(record.commit, selected.commit)
  assert.equal(record.workflow.runId, selected.runId)
  assert.equal(record.workflow.attempt, selected.attempt)
  const variables = validateRelease(record)
  assert.equal(unzip(['-p', zip, 'images.env']), variables)
  // Recheck final attempt state after downloading; never accept a superseded rerun.
  validateRun(await api(`/actions/runs/${selected.runId}`), selected)
  writeFileSync(join(directory, 'release.json'), JSON.stringify(record, null, 2) + '\n')
  writeFileSync(join(directory, 'images.env'), variables)
  console.log(JSON.stringify({ event: 'release-record-verified', ...selected }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await download()
