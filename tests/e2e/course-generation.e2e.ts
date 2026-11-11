import { validPlanGenerationOutput } from '../../packages/agent-core/test/fixtures/plan-generation.js'
import { test, expect } from './course-generation.fixture.js'

test('课程路线 → 首课学习包 → 站内阅读与开始，全程不需要仓库', async ({ page, courseFlow: f }) => {
  await page.goto('/app/plan')
  await expect(page.getByRole('link', { name: '仓库接入' })).toHaveCount(0)
  await page.getByLabel('学习目标', { exact: true }).fill('学习浏览器事件循环与 Vue 更新')
  await page
    .getByLabel('当前基础', { exact: true })
    .fill('熟悉 Vue 3 和 TypeScript，希望结合浏览器情景理解调度。')
  await page
    .getByLabel('截止日期', { exact: true })
    .fill(new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10))
  await page.getByLabel('每周投入（分钟）', { exact: true }).fill('600')
  await page.getByRole('radio', { name: /R16 合成模型/ }).check()
  await page.getByRole('button', { name: '生成计划', exact: true }).click()
  await expect(page.getByRole('button', { name: '确认并开始', exact: true })).toBeVisible()
  await expect(page.getByText('notes/', { exact: false })).toHaveCount(0)

  const plan = await f.database.plan.findFirstOrThrow({
    where: { goal: { userId: f.userId } },
    include: { stages: { include: { tasks: { orderBy: { position: 'asc' } } } } },
  })
  const [course, next] = plan.stages[0]!.tasks
  if (!course || !next) throw new Error('Expected generated courses')

  await page.getByRole('button', { name: '确认并开始', exact: true }).click()
  await expect
    .poll(
      async () =>
        (await f.database.course.findUniqueOrThrow({ where: { taskId: course.id } })).status,
      { timeout: 20_000 },
    )
    .toBe('READY')
  await expect(page.getByRole('link', { name: '开始学习', exact: true })).toBeVisible({
    timeout: 20_000,
  })
  await page.getByRole('link', { name: '开始学习', exact: true }).click()
  await expect(page).toHaveURL((url) => url.pathname === `/app/tasks/${course.id}`)
  await expect(
    page.getByRole('heading', { name: validPlanGenerationOutput.stages[0].tasks[0].title }),
  ).toBeVisible()
  await expect(page.getByRole('heading', { name: '任务与调用栈', exact: true })).toBeVisible()
  await expect(page.getByText('易错点：', { exact: false }).first()).toBeVisible()
  await expect(page.getByText('笔记提交位置', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '开始学习', exact: true }).click()
  await expect(page.getByLabel('任务状态：进行中', { exact: true })).toBeVisible()

  const saved = await f.database.course.findUniqueOrThrow({
    where: { taskId: course.id },
    include: { versions: { include: { exerciseSet: true } }, generationRuns: true },
  })
  expect(saved.status).toBe('READY')
  expect(saved.versions).toHaveLength(1)
  expect(saved.versions[0]!.exerciseSet).not.toBeNull()
  expect(f.worker.courseModelCalls).toBe(1)
  expect(await f.database.task.findUniqueOrThrow({ where: { id: next.id } })).toMatchObject({
    state: 'BLOCKED',
    type: 'COURSE',
  })

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('heading', { name: '渲染与下一次任务', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
})
