import { randomUUID } from 'node:crypto'
import { test, expect } from './two-users.fixture.js'
import { apiOrigin } from './environment.js'

for (const width of [390, 1280]) {
  test(`计划路线 ${width}px：展开当前任务、定位新解锁任务，重复读取不抢阅读位置`, async ({
    users: { a, database },
  }, testInfo) => {
    await a.page.setViewportSize({ width, height: 900 })
    const task = await database.task.update({ where: { id: a.taskId }, data: { position: 8 } })
    const nextId = randomUUID()
    // 前后各留足内容：滚动断言必须真的跨越视口，不能因为目标原本就在顶部而通过。
    await database.task.createMany({
      data: [...Array.from({ length: 8 }, (_, index) => index), 10, 11, 12, 13].map((position) => ({
        stageId: task.stageId,
        position,
        title: `路线任务 ${position}`,
        description: `路线任务 ${position} 的详细说明`,
        estimatedMinutes: 15,
        state: position < 8 ? 'PASSED' : 'BLOCKED',
      })),
    })
    await database.task.create({
      data: {
        id: nextId,
        stageId: task.stageId,
        position: 9,
        title: '接下来学习的任务',
        description: '解锁后应自动展开的任务说明',
        estimatedMinutes: 15,
        state: 'BLOCKED',
        prerequisites: { create: { prerequisiteTaskId: a.taskId } },
      },
    })
    await a.page.goto(`/app/tasks/${a.taskId}`)
    await a.page.getByRole('link', { name: '← 返回学习计划' }).click()
    const current = a.page.getByRole('article', { name: a.taskTitle, exact: true })
    const next = a.page.getByRole('article', { name: '接下来学习的任务', exact: true })
    const previous = a.page.getByRole('article', { name: '路线任务 0', exact: true })
    await expect(current).toHaveAttribute('aria-current', 'step')
    await expect(current.getByText(task.description, { exact: true })).toBeVisible()
    await expect(next.getByText('解锁后应自动展开的任务说明')).not.toBeVisible()
    const refocus = () =>
      a.page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          value: 'hidden',
        })
        window.dispatchEvent(new Event('visibilitychange'))
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          value: 'visible',
        })
        window.dispatchEvent(new Event('visibilitychange'))
      })
    const nearViewportTop = async (card: typeof current) => {
      const bounds = await card.boundingBox()
      return bounds !== null && bounds.y >= 0 && bounds.y < 50
    }
    await expect.poll(() => nearViewportTop(current)).toBe(true)
    await expect(previous.getByText('路线任务 0 的详细说明')).not.toBeVisible()
    await previous.getByRole('button', { name: '展开路线任务 0的描述' }).click()
    await expect(previous.getByText('路线任务 0 的详细说明')).toBeVisible()
    await previous.getByRole('button', { name: '收起路线任务 0的描述' }).click()
    await expect(previous.getByText('路线任务 0 的详细说明')).not.toBeVisible()

    // 此用例只合成最终业务状态；真实验收解锁仍由 learning-flow 用例覆盖。
    await database.$transaction([
      database.task.update({ where: { id: a.taskId }, data: { state: 'PASSED', version: 8 } }),
      database.task.update({ where: { id: nextId }, data: { state: 'READY', version: 1 } }),
    ])
    await refocus()
    await expect(next).toHaveAttribute('aria-current', 'step', { timeout: 20_000 })
    await expect(next.getByText('接下来学习', { exact: true })).toBeVisible()
    await expect(next.getByText('解锁后应自动展开的任务说明')).toBeVisible()
    await expect(current.getByText(task.description, { exact: true })).not.toBeVisible()
    await expect.poll(() => nearViewportTop(next)).toBe(true)
    expect(await a.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    )
    await a.page.screenshot({ path: testInfo.outputPath(`timeline-${width}.png`), fullPage: true })

    // 让用户回到顶部阅读；同一任务的新 GET 响应不能再次把页面拉走。
    const refreshed = a.page.waitForResponse(`${apiOrigin}/plans/${a.planId}`, { timeout: 20_000 })
    await refocus()
    await a.page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
    expect((await refreshed).status()).toBe(200)
    await a.page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    expect(await a.page.evaluate(() => window.scrollY)).toBe(0)
    await expect(next).toHaveAttribute('aria-current', 'step')
    expect(await database.task.findUniqueOrThrow({ where: { id: nextId } })).toMatchObject({
      state: 'READY',
      version: 1,
    })
  })
}
