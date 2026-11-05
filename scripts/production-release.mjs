// Only invoked by the authenticated release workflow on the confirmed Ubuntu VPS.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  chownSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { pathToFileURL } from 'node:url'
import { services } from './ci-images.mjs'
import { treeDigest, validateRelease } from './release-record.mjs'

const legacy = '/opt/knowledgeops-agent'
const stateRoot = '/var/lib/knowledgeops-delivery'
const maintenance = '/var/lib/knowledgeops-maintenance'
const pm2 = '/root/.nvm/versions/node/v24.19.0/bin/pm2'
const domain = 'game.gerden-shop.cn'

export function validatePulledImage(expected, actual) {
  // .Id is backend-specific (config digest vs manifest/index digest). The exact
  // repository@digest is the cross-host identity already fixed by the CI record.
  assert.ok(
    Array.isArray(actual.RepoDigests) && actual.RepoDigests.includes(expected.reference),
    'Pulled image does not contain the verified repository digest',
  )
  assert.equal(actual.Os, 'linux')
  assert.equal(actual.Architecture, 'amd64')
}

export function prepareRuntime(source) {
  const database = new URL(source.DATABASE_URL)
  assert.equal(database.protocol, 'postgresql:')
  assert.ok(
    ['127.0.0.1', 'localhost'].includes(database.hostname),
    'Review a nonlocal source database before migrating',
  )
  assert.equal(database.port, '15432')
  assert.ok(database.username && database.pathname.length > 1)
  const redis = new URL(source.REDIS_URL)
  assert.equal(redis.protocol, 'redis:')
  assert.ok(['127.0.0.1', 'localhost'].includes(redis.hostname))
  assert.equal(redis.port, '16379')
  assert.ok(
    !redis.username && !redis.password,
    'Review Redis authentication before changing its address',
  )
  assert.equal(source.WEB_ORIGIN, `https://${domain}`)
  assert.equal(source.NUXT_PUBLIC_API_BASE_URL, `https://${domain}/api`)
  assert.equal(source.GITHUB_APP_CALLBACK_URL, `https://${domain}/api/auth/github/callback`)
  for (const key of [
    'GITHUB_APP_CLIENT_ID',
    'GITHUB_APP_CLIENT_SECRET',
    'GITHUB_WEBHOOK_SECRET',
    'GITHUB_APP_PRIVATE_KEY_PATH',
    'OPENAI_API_KEY',
    'NOTE_VERIFICATION_MODEL_JSON',
  ])
    assert.ok(source[key], `Missing ${key}`)
  for (const key of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
  ]) {
    if (source[key])
      assert.ok(
        !['localhost', '127.0.0.1', '[::1]'].includes(new URL(source[key]).hostname),
        'A container cannot use the host loopback proxy',
      )
  }
  database.hostname = 'postgres'
  database.port = '5432'
  const runtime = {
    ...source,
    NODE_ENV: 'production',
    DATABASE_URL: database.href,
    REDIS_URL: 'redis://redis:6379',
    GITHUB_APP_PRIVATE_KEY_PATH: '/run/secrets/knowledgeops/github-app.pem',
  }
  for (const [key, value] of Object.entries(runtime)) {
    assert.match(key, /^[A-Za-z_][A-Za-z\d_]*$/)
    assert.ok(!/[\r\n\0]/.test(value), `Multiline configuration needs review: ${key}`)
  }
  const planTimeout = Number(source.PLAN_GENERATION_TIMEOUT_MS ?? 180000)
  const noteTimeout = Number(source.NOTE_VERIFICATION_TIMEOUT_MS ?? 180000)
  assert.ok(Number.isInteger(planTimeout) && planTimeout >= 10000 && planTimeout <= 1800000)
  assert.ok(Number.isInteger(noteTimeout) && noteTimeout >= 1000 && noteTimeout <= 600000)
  return { runtime, stopSeconds: Math.ceil(Math.max(planTimeout, noteTimeout) / 1000) + 30 }
}

export function assertRollback(target, previous, compatible) {
  assert.equal(
    compatible,
    true,
    'Review database, business state and queue compatibility before rollback',
  )
  assert.ok(previous, 'No recorded successful container release to roll back from')
  assert.equal(
    target.migrationsDigest,
    previous.migrationsDigest,
    'Different migrations require a separate recovery plan',
  )
}

export async function runSteps(steps, save, onFailure = () => {}) {
  for (const [stage, work] of steps) {
    save({ status: 'RUNNING', stage })
    try {
      await work()
    } catch (error) {
      save({ status: 'FAILED', stage })
      onFailure(error)
      throw new Error(`Release stopped at ${stage}; inspect the private VPS log before recovery`, {
        cause: error,
      })
    }
  }
  save({ status: 'SUCCEEDED', stage: 'complete' })
}

async function release() {
  assert.equal(process.platform, 'linux')
  assert.equal(
    process.getuid(),
    0,
    'The reviewed first migration uses the existing root deployment account',
  )
  const [kitArg, deploymentId, operation, compatible] = process.argv.slice(2)
  assert.match(deploymentId, /^deploy-[1-9]\d*-[1-9]\d*$/)
  assert.ok(['check', 'deploy', 'rollback'].includes(operation))
  const kit = resolve(kitArg)
  assert.equal(kit, `${stateRoot}/bundles/${deploymentId}`)
  const record = JSON.parse(readFileSync(join(kit, 'release.json'), 'utf8'))
  validateRelease(record)
  const metadata = JSON.parse(readFileSync(join(kit, 'kit.json'), 'utf8'))
  assert.equal(metadata.sourceCommit, record.commit)
  assert.match(metadata.controlCommit, /^[a-f\d]{40}$/)
  assert.equal(metadata.migrationsDigest, treeDigest(join(kit, 'migrations')))
  mkdirSync(`${stateRoot}/attempts`, { recursive: true, mode: 0o700 })
  mkdirSync(`${stateRoot}/history`, { recursive: true, mode: 0o700 })
  const attempt = `${stateRoot}/attempts/${deploymentId}`
  mkdirSync(attempt, { mode: 0o700 })
  const log = openSync(join(attempt, 'private.log'), 'wx', 0o600)
  const currentFile = `${stateRoot}/current.json`
  const current = existsSync(currentFile) ? JSON.parse(readFileSync(currentFile, 'utf8')) : null
  const saveJson = (path, value) => {
    writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
    renameSync(`${path}.tmp`, path)
  }
  const save = (progress) => {
    const result = {
      deploymentId,
      operation,
      commit: record.commit,
      ciRunId: record.workflow.runId,
      ciAttempt: record.workflow.attempt,
      controlCommit: metadata.controlCommit,
      ...progress,
      timestamp: new Date().toISOString(),
    }
    saveJson(join(attempt, 'result.json'), result)
    console.log(JSON.stringify(result))
  }
  const hostEnv = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` }
  const command = (program, args, options = {}) =>
    execFileSync(program, args, {
      env: hostEnv,
      stdio: ['ignore', log, log],
      timeout: 600000,
      ...options,
    })
  const output = (program, args, options = {}) =>
    command(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', log], ...options }).trim()
  const inspect = (name) => JSON.parse(output('docker', ['inspect', name]))[0]
  let composeEnv, composeArgs, stopSeconds, targetStopSeconds, snapshot
  const compose = (args, options) =>
    command('docker', [...composeArgs, ...args], { env: composeEnv, ...options })
  const containerIds = (service) =>
    output('docker', [...composeArgs, 'ps', '-a', '-q', service], { env: composeEnv })
      .split('\n')
      .filter(Boolean)
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const localHealth = () => {
    command('curl', [
      '--noproxy',
      '*',
      '--max-time',
      '10',
      '-fsS',
      'http://127.0.0.1:4000/health/ready',
    ])
    command('curl', [
      '--noproxy',
      '*',
      '--max-time',
      '10',
      '-fsS',
      '-o',
      '/dev/null',
      'http://127.0.0.1:3200/',
    ])
    command('curl', [
      '--noproxy',
      '*',
      '--resolve',
      `${domain}:443:127.0.0.1`,
      '--max-time',
      '10',
      '-fsS',
      `https://${domain}/api/health/ready`,
    ])
  }
  try {
    const steps = [
      [
        'preflight',
        () => {
          if (operation !== 'rollback')
            assert.ok(
              !existsSync(maintenance),
              'An unfinished release requires inspection before another deployment',
            )
          assert.equal(
            output('docker', [
              'network',
              'inspect',
              'knowledgeops_default',
              '--format',
              '{{index .Labels "com.docker.compose.project"}}',
            ]),
            'knowledgeops',
          )
          for (const [name, volume, destination] of [
            ['postgres', 'knowledgeops_postgres-data', '/var/lib/postgresql/data'],
            ['redis', 'knowledgeops_redis-data', '/data'],
          ]) {
            const container = inspect(`knowledgeops-${name}-1`)
            assert.equal(container.State.Health.Status, 'healthy')
            assert.ok(
              container.Mounts.some(
                (mount) =>
                  mount.Type === 'volume' &&
                  mount.Name === volume &&
                  mount.Destination === destination,
              ),
            )
          }
          assert.equal(
            output('docker', [
              'ps',
              '-q',
              '--filter',
              'label=com.docker.compose.project=knowledgeops',
              '--filter',
              'label=com.docker.compose.service=migrate',
            ]),
            '',
            'A previous migration container is still running',
          )
          command('nginx', ['-t'])
          const nginx = output('nginx', ['-T'])
          assert.ok(
            nginx.includes(`if (-f ${maintenance})`),
            'Install and reload the reviewed maintenance hook first',
          )
          let sourceFile = `${legacy}/.env`
          let rollbackRecord
          if (operation === 'rollback') {
            assertRollback(metadata, current, compatible === 'true')
            rollbackRecord = JSON.parse(
              readFileSync(
                `${stateRoot}/history/${record.commit}-${record.workflow.runId}-${record.workflow.attempt}.json`,
                'utf8',
              ),
            )
            assert.equal(rollbackRecord.status, 'SUCCEEDED')
            assert.deepEqual(rollbackRecord.images, record.images)
            assert.match(rollbackRecord.deploymentId, /^deploy-[1-9]\d*-[1-9]\d*$/)
            assert.equal(
              rollbackRecord.attempt,
              `${stateRoot}/attempts/${rollbackRecord.deploymentId}`,
            )
            sourceFile = join(rollbackRecord.attempt, 'source.env')
          }
          const source = parseEnv(readFileSync(sourceFile, 'utf8'))
          if (rollbackRecord)
            source.GITHUB_APP_PRIVATE_KEY_PATH = join(
              rollbackRecord.attempt,
              'secrets/github-app.pem',
            )
          const prepared = prepareRuntime(source)
          targetStopSeconds = prepared.stopSeconds
          stopSeconds = Math.max(targetStopSeconds, current?.stopSeconds ?? 0)
          copyFileSync(sourceFile, join(attempt, 'source.env'))
          chmodSync(join(attempt, 'source.env'), 0o600)
          const envFile = join(attempt, 'runtime.env')
          writeFileSync(
            envFile,
            Object.entries(prepared.runtime)
              .map(([key, value]) => `${key}=${value}`)
              .join('\n') + '\n',
            { mode: 0o600 },
          )
          const secrets = join(attempt, 'secrets')
          mkdirSync(secrets, { mode: 0o750 })
          chownSync(secrets, 0, 1000)
          // SSH runs with umask 077; mkdir's mode alone would leave this at 0700.
          chmodSync(secrets, 0o750)
          const key = join(secrets, 'github-app.pem')
          assert.ok(source.GITHUB_APP_PRIVATE_KEY_PATH.startsWith('/'))
          copyFileSync(source.GITHUB_APP_PRIVATE_KEY_PATH, key)
          chmodSync(key, 0o640)
          chownSync(key, 0, 1000)
          composeEnv = {
            ...process.env,
            ...source,
            PATH: hostEnv.PATH,
            COMPOSE_PROJECT_NAME: 'knowledgeops',
            APP_ENV_FILE: envFile,
            GITHUB_APP_SECRETS_DIR: secrets,
            CONTAINER_DATABASE_URL: prepared.runtime.DATABASE_URL,
            NUXT_PUBLIC_API_BASE_URL: prepared.runtime.NUXT_PUBLIC_API_BASE_URL,
            API_BIND_PORT: '4000',
            WEB_BIND_PORT: '3200',
            WORKER_STOP_SECONDS: String(targetStopSeconds),
          }
          for (const service of services)
            composeEnv[`${service.toUpperCase()}_IMAGE`] = record.images[service].reference
          composeArgs = [
            'compose',
            '--project-name',
            'knowledgeops',
            '--project-directory',
            kit,
            '--env-file',
            '/dev/null',
            '-f',
            join(kit, 'compose.yaml'),
            '-f',
            join(kit, 'compose.apps.yaml'),
            '-f',
            join(kit, 'compose.production.yaml'),
          ]
          compose(['config', '--quiet'])
          for (const service of services) {
            const image = record.images[service]
            try {
              inspect(image.reference)
            } catch {
              command('docker', ['pull', image.reference])
            }
            const actual = inspect(image.reference)
            validatePulledImage(image, actual)
          }
          for (const [service, reader] of [
            ['api', 'readApiEnvironment'],
            ['worker', 'readWorkerEnvironment'],
          ]) {
            compose([
              'run',
              '--rm',
              '--no-deps',
              '-T',
              '--pull',
              'never',
              service,
              'node',
              '--input-type=module',
              '-e',
              `import {${reader}} from './dist/config/environment.js'; import {readFileSync} from 'node:fs'; import {createPrivateKey} from 'node:crypto'; ${reader}(); createPrivateKey(readFileSync(process.env.GITHUB_APP_PRIVATE_KEY_PATH)); console.log('configuration-valid')`,
            ])
          }
          if (current) {
            assert.equal(
              output('systemctl', ['show', 'pm2-root.service', '-p', 'UnitFileState', '--value']),
              'disabled',
            )
            assert.notEqual(
              output('systemctl', ['show', 'pm2-root.service', '-p', 'ActiveState', '--value']),
              'active',
            )
          }
          if (!current) {
            assert.notEqual(operation, 'rollback')
            const processes = JSON.parse(output(pm2, ['jlist']))
            assert.ok(
              processes
                .filter(
                  (p) =>
                    !['knowledgeops-api', 'knowledgeops-web', 'knowledgeops-worker'].includes(
                      p.name,
                    ),
                )
                .every((p) => p.pm2_env.status === 'stopped'),
              'Other root PM2 processes need a separate service migration plan',
            )
            for (const name of ['knowledgeops-api', 'knowledgeops-web', 'knowledgeops-worker'])
              assert.equal(
                processes.filter((p) => p.name === name && p.pm2_env.status === 'online').length,
                1,
              )
            assert.ok(
              processes.find((p) => p.name === 'knowledgeops-worker').pm2_env.kill_timeout >=
                stopSeconds * 1000,
              'Legacy PM2 shutdown wait is shorter than the configured model timeout',
            )
            assert.equal(
              output('git', ['-C', legacy, 'status', '--porcelain']),
              '',
              'Preserve/review local source edits before switching',
            )
          }
          const free = Number(
            output('df', ['--output=avail', '-B1', stateRoot]).split('\n').at(-1).trim(),
          )
          assert.ok(free > 5 * 1024 ** 3, 'Insufficient backup headroom')
          saveJson(
            join(attempt, 'previous.json'),
            current ?? {
              kind: 'pm2',
              commit: output('git', ['-C', legacy, 'rev-parse', 'HEAD']),
              migrationsDigest: treeDigest(`${legacy}/prisma/migrations`),
            },
          )
        },
      ],
      [
        'maintenance-and-stop',
        () => {
          writeFileSync(maintenance, deploymentId + '\n', { mode: 0o644 })
          for (const path of ['/', '/api/auth/session'])
            assert.equal(
              output('curl', [
                '--noproxy',
                '*',
                '--resolve',
                `${domain}:443:127.0.0.1`,
                '--max-time',
                '10',
                '-sS',
                '-o',
                '/dev/null',
                '-w',
                '%{http_code}',
                `https://${domain}${path}`,
              ]),
              '503',
              'Maintenance hook is not active',
            )
          if (!current) {
            for (const name of ['knowledgeops-api', 'knowledgeops-web', 'knowledgeops-worker'])
              command(pm2, ['stop', name], { timeout: (stopSeconds + 60) * 1000 })
            const processes = JSON.parse(output(pm2, ['jlist']))
            assert.ok(
              processes
                .filter((p) => p.name.startsWith('knowledgeops-'))
                .every((p) => p.pm2_env.status === 'stopped' && p.pm2_env.exit_code !== 137),
            )
            command('systemctl', ['disable', '--now', 'pm2-root.service'], {
              timeout: (stopSeconds + 60) * 1000,
            })
          } else {
            compose(['stop', 'api', 'web'])
            compose(['stop', '-t', String(stopSeconds), 'worker'], {
              timeout: (stopSeconds + 60) * 1000,
            })
            for (const service of ['api', 'web', 'worker'])
              for (const id of containerIds(service)) {
                const stopped = inspect(id).State
                assert.equal(stopped.Running, false)
                assert.equal(stopped.OOMKilled, false)
                assert.ok(
                  [0, 143].includes(stopped.ExitCode),
                  'Inspect an abnormal shutdown before migrating',
                )
              }
          }
        },
      ],
      [
        'backup',
        () => {
          const backup = `/var/backups/knowledgeops/${deploymentId}`
          mkdirSync(dirname(backup), { recursive: true, mode: 0o700 })
          mkdirSync(backup, { mode: 0o700 })
          snapshot = backup
          copyFileSync(join(attempt, 'source.env'), join(backup, 'production.env'))
          chmodSync(join(backup, 'production.env'), 0o600)
          const dump = openSync(join(backup, 'database.dump'), 'wx', 0o600)
          try {
            command(
              'docker',
              [
                'exec',
                'knowledgeops-postgres-1',
                'sh',
                '-c',
                'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-acl',
              ],
              { stdio: ['ignore', dump, log] },
            )
          } finally {
            closeSync(dump)
          }
          assert.ok(statSync(join(backup, 'database.dump')).size > 0)
          const input = openSync(join(backup, 'database.dump'), 'r')
          try {
            command('docker', ['exec', '-i', 'knowledgeops-postgres-1', 'pg_restore', '--list'], {
              stdio: [input, 'ignore', log],
            })
          } finally {
            closeSync(input)
          }
          if (!current) {
            command('tar', [
              '-czf',
              join(backup, 'legacy-runtime.tar.gz'),
              '--exclude=.git',
              '-C',
              legacy,
              '.',
            ])
            command('gzip', ['-t', join(backup, 'legacy-runtime.tar.gz')])
            writeFileSync(
              join(backup, 'pm2-root.unit.txt'),
              output('systemctl', ['cat', 'pm2-root.service']),
              { mode: 0o600 },
            )
          }
          const sums = openSync(join(backup, 'SHA256SUMS'), 'wx', 0o600)
          try {
            command('sha256sum', ['database.dump', ...(current ? [] : ['legacy-runtime.tar.gz'])], {
              cwd: backup,
              stdio: ['ignore', sums, log],
            })
          } finally {
            closeSync(sums)
          }
          saveJson(
            join(backup, 'previous.json'),
            JSON.parse(readFileSync(join(attempt, 'previous.json'), 'utf8')),
          )
        },
      ],
      [
        'migrate',
        () => {
          if (operation === 'deploy')
            compose(['run', '--rm', '--no-deps', '-T', '--pull', 'never', 'migrate'])
        },
      ],
      [
        'start-and-check',
        async () => {
          compose([
            'up',
            '-d',
            '--no-deps',
            '--no-build',
            '--pull',
            'never',
            '--wait',
            '--wait-timeout',
            '120',
            'api',
            'web',
          ])
          localHealth()
          compose(['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'worker'])
          const ids = containerIds('worker')
          assert.equal(ids.length, 1)
          const started = inspect(ids[0]).State.StartedAt
          let ready = false
          for (let i = 0; i < 15; i++) {
            await wait(2000)
            const worker = inspect(ids[0])
            assert.equal(worker.State.Running, true)
            assert.equal(worker.RestartCount, 0)
            const logs = output('docker', ['logs', '--since', started, ids[0]])
            if (logs.includes('worker_runtime_started')) {
              ready = true
              break
            }
          }
          assert.ok(ready, 'Worker did not report runtime readiness')
          await wait(5000)
          assert.equal(inspect(ids[0]).RestartCount, 0)
          localHealth()
        },
      ],
      [
        'activate',
        () => {
          const successful = {
            status: 'SUCCEEDED',
            deploymentId,
            commit: record.commit,
            controlCommit: metadata.controlCommit,
            migrationsDigest: metadata.migrationsDigest,
            stopSeconds: targetStopSeconds,
            images: record.images,
            kit,
            attempt,
            backup: snapshot,
            previousDeploymentId: current?.deploymentId ?? null,
          }
          // An interrupted activation retains maintenance. Reconcile its attempt before reopening.
          saveJson(currentFile, successful)
          saveJson(
            `${stateRoot}/history/${record.commit}-${record.workflow.runId}-${record.workflow.attempt}.json`,
            successful,
          )
          unlinkSync(maintenance)
        },
      ],
    ]
    await runSteps(operation === 'check' ? steps.slice(0, 1) : steps, save, (error) => {
      writeSync(log, `${error.stack ?? error.message}\n`)
    })
  } catch (error) {
    if (existsSync(maintenance) && readFileSync(maintenance, 'utf8').trim() === deploymentId) {
      // Once maintenance began, do not leave a partially started consumer writing after failure.
      try {
        compose(['stop', '-t', String(stopSeconds), 'api', 'web', 'worker'], {
          timeout: (stopSeconds + 90) * 1000,
        })
      } catch {
        console.error('Container stop needs manual inspection')
      }
      if (
        !current &&
        output('systemctl', ['show', 'pm2-root.service', '-p', 'ActiveState', '--value']) ===
          'active'
      ) {
        for (const name of ['knowledgeops-api', 'knowledgeops-web', 'knowledgeops-worker']) {
          try {
            command(pm2, ['stop', name], { timeout: (stopSeconds + 60) * 1000 })
          } catch {
            console.error(`Inspect legacy process: ${name}`)
          }
        }
      }
    }
    throw error
  } finally {
    closeSync(log)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await release()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
