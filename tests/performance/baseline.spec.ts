import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { performanceApiOrigin, performanceIds, type PerformanceScenario } from './fixtures.js'
import { measurePerformance, type PerformanceSample } from './measure.js'

const sampleCount = readIntegerEnv('PERFORMANCE_SAMPLES', 3, 1, 10)
const observationWindowMs = readIntegerEnv('PERFORMANCE_OBSERVATION_MS', 5_500, 1_000, 30_000)
const outputPath = resolve(
  process.env.PERFORMANCE_BASELINE_OUTPUT ?? 'test-results/performance-baseline.json',
)

const scenarios: {
  id: PerformanceScenario
  path: string
  ready: (page: Page) => Promise<void>
  interact: (page: Page) => Promise<void>
}[] = [
  {
    id: 'anonymous',
    path: '/app/plan',
    ready: async (page) => {
      await expect(page.getByLabel('学习目标', { exact: true })).toBeVisible()
    },
    interact: async (page) => {
      const input = page.getByLabel('学习目标', { exact: true })
      await input.click()
      await input.pressSequentially('event loop', { delay: 20 })
    },
  },
  {
    id: 'plan',
    path: `/app/plan?plan=${performanceIds.plan}`,
    ready: async (page) => {
      await expect(
        page.getByRole('heading', { name: '准备前端实习面试', exact: true }),
      ).toBeVisible()
      await expect(page.getByText('理解浏览器事件循环', { exact: true })).toBeVisible()
    },
    interact: async (page) => {
      await page.getByRole('heading', { name: '准备前端实习面试', exact: true }).click()
    },
  },
  {
    id: 'course',
    path: `/app/tasks/${performanceIds.task}`,
    ready: async (page) => {
      await expect(page.getByRole('heading', { name: '任务与调用栈', exact: true })).toBeVisible()
    },
    interact: async (page) => {
      await page.getByRole('tab', { name: '课程内容', exact: true }).click()
    },
  },
  {
    id: 'activity',
    path: `/app/tasks/${performanceIds.task}?tab=exercise`,
    ready: async (page) => {
      await expect(page.getByText('正在验收本次练习', { exact: false })).toBeVisible()
    },
    interact: async (page) => {
      await page.getByRole('tab', { name: '练习与验收', exact: true }).click()
    },
  },
]

test('采集四类页面冷启动与缓存后性能基线', async ({ browser }, testInfo) => {
  test.setTimeout(
    Math.max(300_000, sampleCount * scenarios.length * 2 * (observationWindowMs + 15_000)),
  )
  const results: {
    scenario: PerformanceScenario
    cache: 'cold' | 'warm'
    samples: PerformanceSample[]
  }[] = []

  for (const scenario of scenarios) {
    for (let index = 0; index < sampleCount; index += 1) {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        reducedMotion: 'reduce',
      })
      await context.addCookies([
        {
          name: 'performance_scenario',
          value: scenario.id,
          url: performanceApiOrigin,
          sameSite: 'Lax',
        },
      ])
      try {
        for (const cache of ['cold', 'warm'] as const) {
          console.log(`测量 ${scenario.id}/${cache}，第 ${index + 1}/${sampleCount} 轮`)
          const page = await context.newPage()
          const sample = await measurePerformance(page, {
            path: scenario.path,
            ready: () => scenario.ready(page),
            interact: () => scenario.interact(page),
            observationWindowMs,
          })
          expect(sample.fcpMs, `${scenario.id}/${cache}: FCP`).not.toBeNull()
          expect(sample.lcpMs, `${scenario.id}/${cache}: LCP`).not.toBeNull()
          expect(sample.interactionCount, `${scenario.id}/${cache}: real input`).toBeGreaterThan(0)
          results.push({ scenario: scenario.id, cache, samples: [sample] })
          await page.close()
        }
      } finally {
        await context.close()
      }
    }
  }

  const grouped = scenarios.flatMap((scenario) =>
    (['cold', 'warm'] as const).map((cache) => ({
      scenario: scenario.id,
      cache,
      samples: results
        .filter((result) => result.scenario === scenario.id && result.cache === cache)
        .flatMap((result) => result.samples),
    })),
  )
  const report = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    environment: {
      browser: `Chromium ${browser.version()}`,
      viewport: '1280x720',
      sampleCount,
      observationWindowMs,
      note: 'Local laboratory samples with synthetic API responses; not production RUM or real-device p75. INP is the maximum Event Timing duration for one fixed interaction; null means no entry reached the 16ms reporting threshold.',
      transferBytes:
        'Static resources use PerformanceResourceTiming.transferSize including headers. Cross-origin API uses encoded response body bytes excluding headers; cache hits may be zero.',
      decodedBytes: 'Decoded response body bytes read by Playwright.',
    },
    scenarios: grouped.map((group) => ({ ...group, summary: summarize(group.samples) })),
  }
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await testInfo.attach('performance-baseline', {
    path: outputPath,
    contentType: 'application/json',
  })
  console.table(
    report.scenarios.map(({ scenario, cache, summary }) => ({
      scenario,
      cache,
      requests: summary.requestCount.median,
      networkRequests: summary.networkRequestCount.median,
      transferBytes: summary.transferBytes.median,
      decodedBytes: summary.decodedBytes.median,
      fcpMs: round(summary.fcpMs.median),
      lcpMs: round(summary.lcpMs.median),
      inpMs: round(summary.inpMs.median),
      cls: round(summary.cls.median),
    })),
  )
})

const metricKeys = [
  'requestCount',
  'networkRequestCount',
  'transferBytes',
  'decodedBytes',
  'fcpMs',
  'lcpMs',
  'inpMs',
  'cls',
] as const

function summarize(samples: PerformanceSample[]) {
  return Object.fromEntries(
    metricKeys.map((key) => {
      const values = samples
        .map((sample) => sample[key])
        .filter((value): value is number => typeof value === 'number')
        .sort((left, right) => left - right)
      const middle = Math.floor(values.length / 2)
      const median =
        values.length === 0
          ? null
          : values.length % 2 === 1
            ? values[middle]!
            : (values[middle - 1]! + values[middle]!) / 2
      return [key, { samples: values, min: values[0] ?? null, max: values.at(-1) ?? null, median }]
    }),
  ) as Record<
    (typeof metricKeys)[number],
    { samples: number[]; min: number | null; max: number | null; median: number | null }
  >
}

function readIntegerEnv(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

function round(value: number | null) {
  return value === null ? null : Math.round(value * 100) / 100
}
