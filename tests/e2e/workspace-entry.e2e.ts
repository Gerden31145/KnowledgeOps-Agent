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
    await expect(actor.page.getByRole('heading', { name: '完整学习路线' })).toBeVisible()
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
  for (const width of [1280, 390]) {
    await a.page.setViewportSize({ width, height: 900 })
    const unusedWidth = await a.page
      .getByRole('region', { name: '创建学习计划' })
      .evaluate((el) => {
        const main = document.querySelector('main')!
        const style = getComputedStyle(main)
        return (
          main.clientWidth -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight) -
          el.getBoundingClientRect().width
        )
      })
    expect(Math.abs(unusedWidth)).toBeLessThanOrEqual(1)
    expect(await a.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    )
    await a.page.screenshot({ path: testInfo.outputPath(`form-${width}.png`), fullPage: true })
  }
  // 从生产构建实际读取图标，防止只有 head 声明、资源却未交付。
  for (const [href, contentType, signature] of [
    ['/favicon.ico', /image\/(?:x-icon|vnd.microsoft.icon)/, '00000100'],
    ['/favicon-96x96.png', /image\/png/, '89504e47'],
  ] as const) {
    await expect(a.page.locator(`head link[rel="icon"][href="${href}"]`)).toHaveCount(1)
    const response = await a.context.request.get(`${webOrigin}${href}`)
    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toMatch(contentType)
    expect((await response.body()).subarray(0, 4).toString('hex')).toBe(signature)
  }
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
  await expect(a.page.getByRole('heading', { name: '完整学习路线' })).toBeVisible()
  await expect(a.page.getByText('刚才填写的新目标尚未生成', { exact: false })).toBeVisible()
  expect(
    await a.page.evaluate(
      () => JSON.parse(sessionStorage.getItem('knowledgeops:goal-draft')!).form.title,
    ),
  ).toBe('学习浏览器渲染')
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

test('慢会话期间匿名表单可用，会话确认前不显示私有计划', async ({ users: { a } }) => {
  await a.context.clearCookies()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await a.page.route(`${apiOrigin}/auth/session`, async (route) => {
    await gate
    await route.continue()
  })
  const sessionRequest = a.page.waitForRequest(
    (request) => request.url() === `${apiOrigin}/auth/session`,
  )
  try {
    await a.page.goto('/app/plan', { waitUntil: 'domcontentloaded' })
    await sessionRequest
    await expect(a.page.getByRole('heading', { name: '想学些什么？' })).toBeVisible()
    await expect(a.page.getByLabel('学习目标', { exact: true })).toBeEditable()
    await expect(a.page.getByRole('heading', { name: '完整学习路线' })).toHaveCount(0)
  } finally {
    release()
  }
  await expect(a.page.getByRole('button', { name: '登录后生成', exact: true })).toBeVisible()
})

test('已登录默认入口并行预读，会话确认前不展示入口中的私有计划', async ({ users: { a } }) => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let sessionRequests = 0
  let entryRequests = 0
  await a.page.route(`${apiOrigin}/auth/session`, async (route) => {
    sessionRequests += 1
    await gate
    await route.continue()
  })
  await a.page.route(`${apiOrigin}/workspace/entry`, async (route) => {
    entryRequests += 1
    await route.continue()
  })
  const entryResponse = a.page.waitForResponse(
    (response) => response.url() === `${apiOrigin}/workspace/entry`,
  )
  try {
    await a.page.goto('/app/plan', { waitUntil: 'domcontentloaded' })
    expect((await entryResponse).status()).toBe(200)
    await expect(a.page.getByRole('heading', { name: '完整学习路线' })).toHaveCount(0)
    await expect(a.page.getByText(a.taskTitle, { exact: true })).toHaveCount(0)
    await expect(a.page.getByRole('heading', { name: '想学些什么？' })).toBeVisible()
  } finally {
    release()
  }
  await expect(a.page.getByRole('heading', { name: '完整学习路线' })).toBeVisible()
  await expect(a.page.getByText(a.taskTitle, { exact: true })).toBeVisible()
  expect(sessionRequests).toBe(1)
  expect(entryRequests).toBe(1)
})

test('会话网络异常时保留错误状态，不展示私有计划或创建表单', async ({ users: { a } }) => {
  await a.page.route(`${apiOrigin}/auth/session`, (route) => route.abort())
  await a.page.goto('/app/plan')
  await expect(a.page.getByRole('heading', { name: '暂时无法确认登录状态' })).toBeVisible()
  await expect(a.page.getByText(a.taskTitle, { exact: true })).toHaveCount(0)
  await expect(a.page.getByRole('region', { name: '创建学习计划' })).toHaveCount(0)
  await expect(a.page.getByRole('button', { name: '重新读取', exact: true })).toBeVisible()
})
