import { expect, test, type Browser } from '@playwright/test'
import {
  performanceApiOrigin,
  performanceIds,
  performanceWebOrigin,
  type PerformanceScenario,
} from './fixtures.js'

const legacyModules = ['/agent-runs/', '/repositories/binding', '/follow-up-questions/']
const courseModules = ['/course-generation-runs', '/course-questions', '/exercise-submissions']

test('匿名页与计划页不下载课程或旧笔记仓库模块', async ({ browser }) => {
  for (const scenario of ['anonymous', 'plan'] as const) {
    const path = scenario === 'anonymous' ? '/app/plan' : `/app/plan?plan=${performanceIds.plan}`
    const { source, decodedBytes } = await readPageJavaScript(browser, scenario, path)
    for (const marker of [...courseModules, ...legacyModules]) {
      expect(source, `${scenario} 不应下载 ${marker}`).not.toContain(marker)
    }
    console.log(`${scenario} 首屏 JS 解码体积：${decodedBytes} B`)
  }
})

test('课程页保留课程模块但不下载旧笔记仓库模块', async ({ browser }) => {
  const { source, decodedBytes } = await readPageJavaScript(
    browser,
    'course',
    `/app/tasks/${performanceIds.task}`,
  )
  for (const marker of courseModules) expect(source).toContain(marker)
  for (const marker of legacyModules)
    expect(source, `课程页不应下载 ${marker}`).not.toContain(marker)
  console.log(`course 首屏 JS 解码体积：${decodedBytes} B`)
})

async function readPageJavaScript(browser: Browser, scenario: PerformanceScenario, path: string) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  await context.addCookies([
    { name: 'performance_scenario', value: scenario, url: performanceApiOrigin, sameSite: 'Lax' },
  ])
  const page = await context.newPage()
  const responses: Promise<string>[] = []
  page.on('response', (response) => {
    const url = new URL(response.url())
    if (url.origin === performanceWebOrigin && url.pathname.endsWith('.js')) {
      responses.push(response.text())
    }
  })
  try {
    await page.goto(path, { waitUntil: 'domcontentloaded' })
    if (scenario === 'anonymous') {
      await expect(page.getByLabel('学习目标', { exact: true })).toBeVisible()
    } else if (scenario === 'plan') {
      await expect(
        page.getByRole('heading', { name: '准备前端实习面试', exact: true }),
      ).toBeVisible()
    } else {
      await expect(page.getByRole('heading', { name: '任务与调用栈', exact: true })).toBeVisible()
    }
    const sources = await Promise.all(responses)
    return {
      source: sources.join('\n'),
      decodedBytes: sources.reduce((total, source) => total + Buffer.byteLength(source), 0),
    }
  } finally {
    await context.close()
  }
}
