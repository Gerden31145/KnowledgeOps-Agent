import type { ServiceName } from '@knowledgeops/contracts'

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const

export type LogLevel = (typeof LOG_LEVELS)[number]

export interface StructuredLogEntry {
  timestamp: string
  level: LogLevel
  service: ServiceName
  context?: string
  message: string
  data?: unknown
  error?: {
    name: string
    message: string
    stack?: string
  }
}

export interface StructuredLoggerOptions {
  service: ServiceName
  minimumLevel?: LogLevel
  now?: () => Date
  write?: (entry: StructuredLogEntry) => void
}

const logLevelWeight: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

const sensitiveKeyPattern =
  /^(authorization|cookie|set-cookie|password|secret|token|access[-_]?token|refresh[-_]?token|api[-_]?key)$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sanitize(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    return value
  }

  if (typeof value === 'string') {
    return value
  }

  if (typeof value === 'bigint') {
    return value.toString()
  }

  if (typeof value === 'symbol' || typeof value === 'function') {
    return String(value)
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack ? { stack: value.stack } : {}),
    }
  }

  if (depth >= 5) {
    return '[MAX_DEPTH]'
  }

  if (seen.has(value)) {
    return '[CIRCULAR]'
  }

  seen.add(value)

  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, seen, depth + 1))
  }

  const sanitized: Record<string, unknown> = {}

  for (const [key, item] of Object.entries(value)) {
    sanitized[key] = sensitiveKeyPattern.test(key) ? '[REDACTED]' : sanitize(item, seen, depth + 1)
  }

  return sanitized
}

function defaultWriter(entry: StructuredLogEntry) {
  const line = `${JSON.stringify(entry)}\n`
  const stream = entry.level === 'error' ? process.stderr : process.stdout
  stream.write(line)
}

export class StructuredLogger {
  private readonly minimumLevel: LogLevel
  private readonly now: () => Date
  private readonly writer: (entry: StructuredLogEntry) => void

  constructor(private readonly options: StructuredLoggerOptions) {
    this.minimumLevel = options.minimumLevel ?? 'info'
    this.now = options.now ?? (() => new Date())
    this.writer = options.write ?? defaultWriter
  }

  log(message: unknown, ...optionalParams: unknown[]) {
    this.emit('info', message, optionalParams)
  }

  error(message: unknown, ...optionalParams: unknown[]) {
    this.emit('error', message, optionalParams)
  }

  warn(message: unknown, ...optionalParams: unknown[]) {
    this.emit('warn', message, optionalParams)
  }

  debug(message: unknown, ...optionalParams: unknown[]) {
    this.emit('debug', message, optionalParams)
  }

  verbose(message: unknown, ...optionalParams: unknown[]) {
    this.emit('debug', message, optionalParams)
  }

  fatal(message: unknown, ...optionalParams: unknown[]) {
    this.emit('error', message, optionalParams)
  }

  private emit(level: LogLevel, rawMessage: unknown, optionalParams: unknown[]) {
    if (logLevelWeight[level] < logLevelWeight[this.minimumLevel]) {
      return
    }

    const contextCandidate = optionalParams.at(-1)
    const hasContext = typeof contextCandidate === 'string'
    const context = hasContext ? contextCandidate : undefined
    const additionalData = hasContext ? optionalParams.slice(0, -1) : optionalParams
    const entry: StructuredLogEntry = {
      timestamp: this.now().toISOString(),
      level,
      service: this.options.service,
      message: this.messageText(rawMessage),
    }

    if (context) {
      entry.context = context
    }

    if (rawMessage instanceof Error) {
      entry.error = {
        name: rawMessage.name,
        message: rawMessage.message,
        ...(rawMessage.stack ? { stack: rawMessage.stack } : {}),
      }
    } else if (isRecord(rawMessage)) {
      const data = Object.fromEntries(Object.entries(rawMessage).filter(([key]) => key !== 'event'))
      entry.data = sanitize(data)
    }

    if (additionalData.length > 0) {
      entry.data = {
        ...(isRecord(entry.data) ? entry.data : {}),
        additional: sanitize(additionalData),
      }
    }

    this.writer(entry)
  }

  private messageText(message: unknown) {
    if (message instanceof Error) {
      return message.message
    }

    if (isRecord(message) && typeof message.event === 'string') {
      return message.event
    }

    return typeof message === 'string' ? message : 'structured_event'
  }
}
