import { test, expect } from './two-users.fixture.js'
import { apiOrigin, webOrigin } from './environment.js'

test('默认入口恢复各自活动计划，旧入口兼容且读取失败不会显示创建表单', async ({
  users: { a, b },
}, testInfo) => {
  for (const actor of [a, b]) {
    const response = await actor.context.request.get(`${apiOrigin}/workspace/entry`)
    expect(response.status()).toBe(200)
    expect(await response.json()).toMatchObject({ planId: actor.planId, runId: null })
    await actor.page.goto('/')
    await expect(actor.page.getByRole('heading', { name: '接下来做什么' })).toBeVisible()
    await expect(
      actor.page.getByRole('navigation').getByText('今日学习', { exact: true }),
    ).toHaveCount(0)
    await actor.page.goto('/app/today')
    await expect(actor.page).toHaveURL(`${webOrigin}/app/plan`)
    await expect(actor.page.getByRole('heading', { name: '完整学习路线' })).toBeVisible()
  }
  await a.page.screenshot({ path: testInfo.outputPath('plan-desktop.png'), fullPage: true })
  await a.page.route(`${apiOrigin}/workspace/entry`, (route) => route.abort())
  await a.page.reload()
  await expect(a.page.getByRole('heading', { name: '学习进度读取失败' })).toBeVisible()
  await expect(a.page.getByRole('button', { name: '生成计划', exact: true })).toHaveCount(0)
})

test('访客表单保留输入，登录回到已有计划且不会自动生成', async ({ users: { a } }, testInfo) => {
  await a.context.clearCookies()
  const writes: string[] = []
  a.page.on('request', (request) => {
    if (request.url().startsWith(apiOrigin) && request.method() === 'POST')
      writes.push(request.url())
  })
  expect((await a.context.request.get(`${apiOrigin}/workspace/entry`)).status()).toBe(401)
  await a.page.goto('/')
  await expect(a.page.getByRole('heading', { name: '想学些什么？' })).toBeVisible()
  await a.page.screenshot({ path: testInfo.outputPath('form-desktop.png'), fullPage: true })
  await a.page.setViewportSize({ width: 390, height: 900 })
  expect(await a.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await a.page.screenshot({ path: testInfo.outputPath('form-mobile.png'), fullPage: true })
  await a.page.getByPlaceholder('例如：用两周补齐 JavaScript 异步机制').fill('学习浏览器渲染')
  await a.page
    .getByPlaceholder('已经掌握什么？哪些地方还不熟悉？')
    .fill('熟悉 Vue，希望补齐浏览器基础')
  await a.page.getByRole('button', { name: '登录后生成', exact: true }).click()
  await expect(a.page).toHaveURL(/\/login\?next=/)
  // 用真实会话模拟已完成 OAuth；不调用 GitHub 或付费模型。
  await a.context.addCookies([
    {
      name: 'knowledgeops_session',
      value: a.token,
      url: webOrigin,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ])
  await a.page.goto('/app/plan')
  await expect(a.page.getByRole('heading', { name: '接下来做什么' })).toBeVisible()
  await expect(a.page.getByText('刚才填写的新目标尚未生成', { exact: false })).toBeVisible()
  expect(
    await a.page.evaluate(
      () => JSON.parse(sessionStorage.getItem('knowledgeops:goal-draft')!).form.title,
    ),
  ).toBe('学习浏览器渲染')
  expect(writes).toEqual([])
})

test('登录后回到原任务的指定报告和页签，不触发业务写入', async ({ users: { a } }) => {
  await a.context.clearCookies()
  const writes: string[] = []
  a.page.on('request', (request) => {
    if (request.url().startsWith(apiOrigin) && request.method() === 'POST')
      writes.push(request.url())
  })
  const target = `/app/tasks/${a.taskId}?runId=${a.runId}&tab=feedback`
  await a.page.goto(target)
  await expect(a.page).toHaveURL(/\/login\?next=/)
  // 仅替代外部 OAuth 跳转；应用保存返回位置与回调后的恢复逻辑保持真实。
  await a.page.route(`${apiOrigin}/auth/github/login`, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<p>OAuth fixture</p>' }),
  )
  await a.page.getByRole('link', { name: '继续使用 GitHub' }).click()
  await expect(a.page).toHaveURL(`${apiOrigin}/auth/github/login`)
  await a.context.addCookies([
    {
      name: 'knowledgeops_session',
      value: a.token,
      url: webOrigin,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ])
  await a.page.goto('/app/plan')
  await expect(a.page).toHaveURL(`${webOrigin}${target}`)
  await expect(a.page.getByText(a.rationale, { exact: true })).toBeVisible()
  expect(
    await a.page.evaluate(() => sessionStorage.getItem('knowledgeops:login-return')),
  ).toBeNull()
  expect(writes).toEqual([])
})

test('没有活动计划时从默认入口恢复草稿及生成中的运行', async ({ users: { a, database } }) => {
  await database.plan.update({ where: { id: a.planId }, data: { status: 'DRAFT' } })
  await a.page.goto('/app/plan')
  await expect(a.page.getByRole('button', { name: '确认并开始' })).toBeVisible()
  const plan = await database.plan.findUniqueOrThrow({ where: { id: a.planId } })
  const run = await database.planGenerationRun.create({
    data: {
      goalId: plan.goalId,
      modelCatalogId: 'r16-fixture',
      modelProvider: 'fixture',
      modelName: 'fixture',
      promptVersion: 'fixture',
      outputSchemaVersion: 'fixture',
      deadlineAt: new Date(Date.now() + 600_000),
    },
  })
  await a.page.reload()
  await expect(a.page.getByRole('heading', { name: '正在为你生成学习计划' })).toBeVisible()
  await database.planGenerationRun.update({
    where: { id: run.id },
    data: {
      status: 'FAILED',
      finishedAt: new Date(),
      version: 1,
      errorCode: 'MODEL_UNAVAILABLE',
      errorMessage: '合成生成失败',
    },
  })
  await a.page.reload()
  await expect(a.page.getByRole('heading', { name: '本次生成未完成' })).toBeVisible()
  await expect(a.page.getByRole('button', { name: '重新生成' })).toBeVisible()
})

for (const width of [390, 1280]) {
  test(`任务页 ${width}px：路径突出、双页签键盘切换、刷新恢复指定报告`, async ({
    users: { a },
  }, testInfo) => {
    await a.page.setViewportSize({ width, height: 900 })
    await a.page.goto(`/app/tasks/${a.taskId}?runId=${a.runId}`)
    await expect(a.page.getByRole('tab', { name: '验收与反馈' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    const location = a.page.getByRole('region', { name: '笔记提交位置' })
    await expect(location.getByRole('heading', { name: '待验收笔记路径' })).toBeVisible()
    await expect(location.getByRole('button', { name: '复制路径' })).toBeVisible()
    const heading = a.page.getByRole('heading', { name: a.taskTitle, exact: true })
    expect(
      await heading.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
    ).toBeLessThanOrEqual(32)
    await a.page.getByRole('tab', { name: '任务说明' }).click()
    await a.page.getByRole('tab', { name: '任务说明' }).press('ArrowRight')
    await expect(a.page.getByRole('tab', { name: '验收与反馈' })).toBeFocused()
    await a.page.reload()
    await expect(a.page.getByText(a.rationale, { exact: true })).toBeVisible()
    expect(await a.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    )
    await a.page.screenshot({ path: testInfo.outputPath(`task-${width}.png`), fullPage: true })
  })
}
