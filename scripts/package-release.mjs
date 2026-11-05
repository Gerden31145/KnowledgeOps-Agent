import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { treeDigest, validateRelease } from './release-record.mjs'

assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.GITHUB_REF, 'refs/heads/main')
const directory = join(process.env.RUNNER_TEMP, 'verified-release')
const record = JSON.parse(readFileSync(join(directory, 'release.json'), 'utf8'))
validateRelease(record)
assert.equal(
  execFileSync('git', ['-C', 'candidate-source', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  record.commit,
)
const bundle = join(process.env.RUNNER_TEMP, 'release-bundle')
mkdirSync(bundle)
mkdirSync(join(bundle, 'scripts'))
for (const name of ['compose.yaml', 'compose.apps.yaml'])
  copyFileSync(`candidate-source/deploy/${name}`, join(bundle, name))
copyFileSync('deploy/compose.production.yaml', join(bundle, 'compose.production.yaml'))
for (const name of ['production-release.mjs', 'release-record.mjs', 'ci-images.mjs'])
  copyFileSync(`scripts/${name}`, join(bundle, 'scripts', name))
copyFileSync(join(directory, 'release.json'), join(bundle, 'release.json'))
cpSync('candidate-source/prisma/migrations', join(bundle, 'migrations'), { recursive: true })
writeFileSync(
  join(bundle, 'kit.json'),
  JSON.stringify(
    {
      sourceCommit: record.commit,
      controlCommit: process.env.GITHUB_SHA,
      migrationsDigest: treeDigest(join(bundle, 'migrations')),
    },
    null,
    2,
  ) + '\n',
)
execFileSync('tar', [
  '-czf',
  join(process.env.RUNNER_TEMP, 'release-bundle.tar.gz'),
  '-C',
  bundle,
  '.',
])
console.log(
  JSON.stringify({
    event: 'release-bundle-prepared',
    commit: record.commit,
    controlCommit: process.env.GITHUB_SHA,
  }),
)
