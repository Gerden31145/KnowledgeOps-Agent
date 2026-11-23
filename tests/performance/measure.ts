import type { Page } from '@playwright/test'
import { performanceApiOrigin, performanceWebOrigin } from './fixtures.js'

export interface RequestMeasurement {
  key: string
  kind: 'api' | 'static' | 'other'
  count: number
  transferBytes: number
  decodedBytes: number
  totalDurationMs: number
  maxDurationMs: number
}

export interface PerformanceSample {
  fcpMs: number | null
  lcpMs: number | null
  inpMs: number | null
  interactionCount: number
  cls: number
  requestCount: number
  networkRequestCount: number
  transferBytes: number
  decodedBytes: number
  requests: RequestMeasurement[]
}

interface BrowserVitals {
  fcpMs: number | null
  lcpMs: number | null
  inpMs: number | null
  interactionCount: number
  cls: number
}

interface NetworkMeasurement {
  key: string
  kind: RequestMeasurement['kind']
  url: string
  transferBytes: number
  decodedBytes: number
  durationMs: number
}

interface BrowserResourceTiming {
  name: string
  transferSize: number
}

const vitalsKey = '__knowledgeOpsPerformanceVitals'

export async function measurePerformance(
  page: Page,
  input: {
    path: string
    ready: () => Promise<void>
    interact: () => Promise<void>
    observationWindowMs: number
  },
): Promise<PerformanceSample> {
  const pendingResponses: Promise<NetworkMeasurement | null>[] = []
  page.on('response', (response) => {
    const measurement = (async (): Promise<NetworkMeasurement | null> => {
      try {
        await response.finished()
        const request = response.request()
        const url = new URL(request.url())
        if (![performanceApiOrigin, performanceWebOrigin].includes(url.origin)) return null
        const [sizes, body] = await Promise.all([
          request.sizes(),
          response.body().catch(() => null),
        ])
        const kind = url.origin === performanceApiOrigin ? 'api' : 'static'
        return {
          key: `${request.method()} ${url.pathname}`,
          kind,
          url: request.url(),
          transferBytes: Math.max(0, sizes.responseBodySize),
          decodedBytes: body?.byteLength ?? Math.max(0, sizes.responseBodySize),
          durationMs: Math.max(0, request.timing().responseEnd),
        }
      } catch {
        return null
      }
    })()
    pendingResponses.push(measurement)
  })

  await page.addInitScript((key) => {
    const vitals: BrowserVitals = {
      fcpMs: null,
      lcpMs: null,
      inpMs: null,
      interactionCount: 0,
      cls: 0,
    }
    Object.assign(window, { [key]: vitals })
    for (const type of ['pointerdown', 'keydown']) {
      window.addEventListener(type, () => {
        vitals.interactionCount += 1
      })
    }
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) vitals.lcpMs = entry.startTime
    }).observe({ type: 'largest-contentful-paint', buffered: true })
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!(entry as PerformanceEntry & { hadRecentInput?: boolean }).hadRecentInput) {
          vitals.cls += (entry as PerformanceEntry & { value: number }).value
        }
      }
    }).observe({ type: 'layout-shift', buffered: true })
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const event = entry as PerformanceEntry & { duration: number; interactionId: number }
        if (event.interactionId > 0) vitals.inpMs = Math.max(vitals.inpMs ?? 0, event.duration)
      }
    }).observe({ type: 'event', buffered: true, durationThreshold: 16 } as PerformanceObserverInit)
  }, vitalsKey)

  await page.goto(input.path, { waitUntil: 'domcontentloaded' })
  await input.ready()
  await input.interact()
  await page.waitForTimeout(input.observationWindowMs)

  const browserMetrics = await page.evaluate(
    (key): { vitals: BrowserVitals; resources: BrowserResourceTiming[] } => {
      const paint = performance
        .getEntriesByType('paint')
        .find((entry) => entry.name === 'first-contentful-paint')
      const stored = Reflect.get(window, key) as Omit<BrowserVitals, 'fcpMs'>
      const resources = [
        ...performance.getEntriesByType('navigation'),
        ...performance.getEntriesByType('resource'),
      ].map((entry) => ({
        name: entry.name,
        transferSize: (entry as PerformanceResourceTiming).transferSize,
      }))
      return {
        vitals: { ...stored, fcpMs: paint?.startTime ?? null },
        resources,
      }
    },
    vitalsKey,
  )
  const vitals = browserMetrics.vitals
  const resourceTransfers = new Map<string, number[]>()
  for (const resource of browserMetrics.resources) {
    resourceTransfers.set(resource.name, [
      ...(resourceTransfers.get(resource.name) ?? []),
      resource.transferSize,
    ])
  }
  const responses = (await Promise.all(pendingResponses))
    .filter((measurement): measurement is NetworkMeasurement => measurement !== null)
    .map((response) => ({
      ...response,
      transferBytes:
        response.kind === 'static'
          ? (resourceTransfers.get(response.url)?.shift() ?? response.transferBytes)
          : response.transferBytes,
    }))
  const grouped = new Map<string, RequestMeasurement>()
  for (const response of responses) {
    const key = `${response.kind} ${response.key}`
    const current = grouped.get(key) ?? {
      key: response.key,
      kind: response.kind,
      count: 0,
      transferBytes: 0,
      decodedBytes: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
    }
    current.count += 1
    current.transferBytes += response.transferBytes
    current.decodedBytes += response.decodedBytes
    current.totalDurationMs += response.durationMs
    current.maxDurationMs = Math.max(current.maxDurationMs, response.durationMs)
    grouped.set(key, current)
  }
  const requests = [...grouped.values()].sort((left, right) => left.key.localeCompare(right.key))
  return {
    ...vitals,
    requestCount: responses.length,
    networkRequestCount: responses.filter((response) => response.transferBytes > 0).length,
    transferBytes: responses.reduce((total, response) => total + response.transferBytes, 0),
    decodedBytes: responses.reduce((total, response) => total + response.decodedBytes, 0),
    requests,
  }
}
