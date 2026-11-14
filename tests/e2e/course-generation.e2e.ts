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

  const explanation = page
    .getByRole('heading', { name: '任务与调用栈', exact: true })
    .locator('..')
    .locator('p')
    .first()
  await explanation.evaluate((element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
  await expect(page.getByText('任务与调用栈 · 选中原文', { exact: true })).toBeVisible()
  await page.getByLabel('深入原理', { exact: false }).check()
  await page.getByLabel('你的问题', { exact: true }).fill('为什么这里不会阻塞下一次渲染？')
  f.questionUpstream.state.failNext = true
  await page.getByRole('button', { name: '发送问题', exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'AI 暂时无法回答' })).toBeVisible()
  await expect(page.getByLabel('你的问题', { exact: true })).toHaveValue(
    '为什么这里不会阻塞下一次渲染？',
  )
  await page.getByRole('button', { name: '重试回答', exact: true }).click()
  await expect(page.getByText('微任务会在当前调用栈清空后', { exact: false })).toBeVisible({
    timeout: 15_000,
  })
  expect(f.questionUpstream.calls).toHaveLength(2)
  expect(f.questionUpstream.calls[1]?.maxTokens).toBe(2048)
  const modelRequest = JSON.parse(f.questionUpstream.calls[1]!.body) as {
    messages: { role: string; content: string }[]
  }
  const learnerContext = modelRequest.messages.find((message) => message.role === 'user')?.content
  expect(learnerContext).not.toContain('correctOptionId')
  expect(learnerContext).not.toContain('rubric')
  expect(learnerContext).not.toContain('exercises')

  await page.reload()
  await expect(
    page.getByText('为什么这里不会阻塞下一次渲染？', { exact: true }).first(),
  ).toBeVisible()
  await expect(page.getByText('微任务会在当前调用栈清空后', { exact: false })).toBeVisible()
  expect(f.questionUpstream.calls).toHaveLength(2)

  const questionRequestIds: string[] = []
  let unreadableNextResponse = true
  await page.route(`**/tasks/${course.id}/course-questions`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    const input = route.request().postDataJSON() as { requestId: string }
    questionRequestIds.push(input.requestId)
    if (unreadableNextResponse) {
      unreadableNextResponse = false
      await route.fetch()
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
      return
    }
    await route.continue()
  })
  await page.getByRole('button', { name: '就本节提问', exact: true }).first().click()
  await page.getByLabel('你的问题', { exact: true }).fill('刷新后还能确认这次提问吗？')
  await page.getByRole('button', { name: '发送问题', exact: true }).click()
  await expect(page.getByRole('button', { name: '重试回答', exact: true })).toBeVisible()
  expect(f.questionUpstream.calls).toHaveLength(3)

  await page.reload()
  await expect(page.getByLabel('你的问题', { exact: true })).toHaveValue(
    '刷新后还能确认这次提问吗？',
  )
  await page.getByRole('button', { name: '发送问题', exact: true }).click()
  await expect(page.getByLabel('你的问题', { exact: true })).toHaveValue('')
  expect(questionRequestIds).toHaveLength(2)
  expect(questionRequestIds[1]).toBe(questionRequestIds[0])
  expect(f.questionUpstream.calls).toHaveLength(3)
  expect(
    await page.evaluate(
      ({ userId, taskId }) =>
        sessionStorage.getItem(`knowledgeops:course-question-command:v1:${userId}:${taskId}`),
      { userId: f.userId, taskId: course.id },
    ),
  ).toBeNull()

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
  await page.getByRole('button', { name: '关闭答疑', exact: true }).click()
  await page.getByRole('button', { name: '课程答疑', exact: true }).click()
  await expect(page.getByRole('button', { name: '关闭答疑', exact: true })).toBeVisible()
  await expect(page.getByText('微任务会在当前调用栈清空后', { exact: false }).last()).toBeVisible()
  await page.getByRole('button', { name: '关闭答疑', exact: true }).click()
  await expect(page.getByRole('button', { name: '课程答疑', exact: true })).toBeVisible()
})
