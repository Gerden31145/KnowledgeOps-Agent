import 'dotenv/config'

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const projectDirectory = dirname(scriptDirectory)
const composePath = join(projectDirectory, 'deploy', 'compose.yaml')
const environmentPath = join(projectDirectory, '.env')
const nativeSetupPath = join(scriptDirectory, 'wsl-native-infra.sh')
const requestedAction = process.argv[2]
const supportedActions = new Set([
  'compose-status',
  'compose-stop',
  'compose-up',
  'native-status',
  'native-stop',
  'native-up',
])

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectDirectory,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    timeout: options.timeout ?? 90_000,
  })

  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') {
      throw new Error(
        `${command} timed out after ${options.timeout ?? 90_000}ms. Check whether WSL responds with "wsl.exe --list --verbose", then retry.`,
      )
    }

    throw result.error
  }

  if (result.status !== 0) {
    const details = options.capture ? (result.stderr || result.stdout).trim() : ''
    throw new Error(`${command} exited with code ${result.status}${details ? `: ${details}` : ''}`)
  }

  return options.capture ? result.stdout.replaceAll('\0', '').trim() : ''
}

function toWslPath(windowsPath) {
  const normalizedPath = windowsPath.replaceAll('\\', '/')
  const drivePath = /^(?<drive>[A-Za-z]):\/(?<rest>.*)$/.exec(normalizedPath)

  if (!drivePath?.groups) {
    throw new Error(`Cannot convert Windows path to WSL path: ${windowsPath}`)
  }

  return `/mnt/${drivePath.groups.drive.toLowerCase()}/${drivePath.groups.rest}`
}

function runDockerCompose(composeArguments) {
  if (process.platform !== 'win32') {
    run('docker', [
      'compose',
      '--env-file',
      environmentPath,
      '--file',
      composePath,
      ...composeArguments,
    ])
    return
  }

  const distribution = process.env.KNOWLEDGEOPS_WSL_DISTRO || 'Ubuntu'
  const wslPrefix = ['-d', distribution, '-u', 'root', '--']
  const composePathInWsl = toWslPath(composePath)
  const environmentPathInWsl = toWslPath(environmentPath)

  run('wsl.exe', [
    ...wslPrefix,
    'docker',
    'compose',
    '--env-file',
    environmentPathInWsl,
    '--file',
    composePathInWsl,
    ...composeArguments,
  ])
}

function main() {
  if (!requestedAction || !supportedActions.has(requestedAction)) {
    throw new Error(`Expected one infrastructure action: ${[...supportedActions].join(', ')}`)
  }

  if (!existsSync(environmentPath)) {
    throw new Error('Missing .env. Copy .env.example to .env before starting infrastructure.')
  }

  if (requestedAction.startsWith('native-')) {
    if (process.platform !== 'win32') {
      throw new Error('Native infrastructure commands are only for Windows development with WSL.')
    }

    const distribution = process.env.KNOWLEDGEOPS_WSL_DISTRO || 'Ubuntu'
    const nativeSetupPathInWsl = toWslPath(nativeSetupPath)
    const environmentPathInWsl = toWslPath(environmentPath)
    const nativeAction = requestedAction.replace('native-', '')
    const timeout = nativeAction === 'up' ? 300_000 : nativeAction === 'status' ? 60_000 : 30_000

    run(
      'wsl.exe',
      [
        '-d',
        distribution,
        '-u',
        'root',
        '--',
        'bash',
        nativeSetupPathInWsl,
        nativeAction,
        environmentPathInWsl,
      ],
      { timeout },
    )
    return
  }

  const composeActions = {
    'compose-status': ['ps'],
    'compose-stop': ['stop'],
    'compose-up': ['up', '--detach', '--wait', '--wait-timeout', '90'],
  }

  runDockerCompose(composeActions[requestedAction])
}

try {
  main()
} catch (error) {
  console.error(`✗ ${errorMessage(error)}`)
  process.exitCode = 1
}
