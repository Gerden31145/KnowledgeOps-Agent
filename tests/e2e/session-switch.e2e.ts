import { randomUUID } from 'node:crypto'
import { test, expect } from './two-users.fixture.js'
import { apiOrigin, webOrigin } from './environment.js'

const commandPrefix = 'knowledgeops:answer-command:v1:'

test('退出 A 后清除本标签页私有命令，安装 B 会话后只读 B 的数据', async ({
  users: { a, b, database },
}) => {
  await a.page.goto(`/app/tasks/${a.taskId}?runId=${a.runId}`)
  await expect(a.page.getByText(a.rationale, { exact: true })).toBeVisible()
  // 合成一份已发出、尚待确认的本地命令；本用例不调用回答验收或模型。
  const key = `${commandPrefix}${a.userId}:${a.taskId}:${randomUUID()}`
  const record = {
    command: { requestId: randomUUID(), expectedTaskVersion: 7, answer: 'A 的私有回答' },
    receipt: null,
  }
  await a.page.evaluate(
    ({ key, record }) => {
      sessionStorage.setItem(key, JSON.stringify(record))
      sessionStorage.setItem('r16-unrelated-preference', 'keep')
    },
    { key, record },
  )
  await a.page.reload()
  await expect(a.page.getByText(a.rationale, { exact: true })).toBeVisible()
  expect(await a.page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)!), key)).toEqual(
    record,
  )

  const loggedOut = a.page.waitForResponse(
    (response) =>
      response.url() === `${apiOrigin}/auth/logout` && response.request().method() === 'POST',
  )
  await a.page.getByRole('button', { name: '退出登录', exact: true }).click()
  expect((await loggedOut).status()).toBe(204)
  await expect(a.page).toHaveURL(`${webOrigin}/login`)
  expect(await database.session.count({ where: { userId: a.userId } })).toBe(0)
  expect(
    (await a.context.cookies(apiOrigin)).some((cookie) => cookie.name === 'knowledgeops_session'),
  ).toBe(false)
  expect(await a.page.evaluate((key) => sessionStorage.getItem(key), key)).toBeNull()
  expect(await a.page.evaluate(() => sessionStorage.getItem('r16-unrelated-preference'))).toBe(
    'keep',
  )

  // 模拟遗留记录 + 已失效会话：整页启动时 user 本来就是 null，也必须在 401 后清理。
  await a.page.evaluate(({ key, record }) => sessionStorage.setItem(key, JSON.stringify(record)), {
    key,
    record,
  })
  await a.page.goto('/app/today')
  await expect(a.page).toHaveURL(`${webOrigin}/app/plan`)
  await expect(a.page.getByRole('heading', { name: '想学些什么？' })).toBeVisible()
  expect(await a.page.evaluate((key) => sessionStorage.getItem(key), key)).toBeNull()

  // 仅用已持久化的 B Cookie 代替外部 OAuth 交换，仍在 A 原来的 context/标签页中。
  await a.context.addCookies([
    {
      name: 'knowledgeops_session',
      value: b.token,
      url: webOrigin,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ])
  await a.page.goto('/app/today')
  await expect(
    a.page
      .getByRole('region', { name: '接下来做什么' })
      .getByRole('heading', { name: b.taskTitle, exact: true }),
  ).toBeVisible()
  await expect(a.page.getByText(a.taskTitle, { exact: true })).toHaveCount(0)
  await a.page.getByRole('link', { name: '查看修改建议', exact: true }).click()
  await expect(a.page.getByText(b.rationale, { exact: true })).toBeVisible()
  await expect(a.page.getByText(a.rationale, { exact: true })).toHaveCount(0)
  await a.page.goto(`/app/tasks/${a.taskId}?runId=${a.runId}`)
  await expect(a.page.getByRole('heading', { name: '任务读取失败', exact: true })).toBeVisible()
  await expect(a.page.getByRole('region', { name: '笔记验收报告', exact: true })).toHaveCount(0)
})

test('同一文档内发现会话从 A 变成 B，清除 A 的 Query 缓存及本地命令', async ({
  users: { a, b },
}) => {
  await a.page.goto('/app/today')
  await expect(
    a.page
      .getByRole('region', { name: '接下来做什么' })
      .getByRole('heading', { name: a.taskTitle, exact: true }),
  ).toBeVisible()
  // 通过 NuxtLink 导航，保留刚读入的 today Query；不能用整页刷新替代清缓存验证。
  await a.page.getByRole('link', { name: '查看修改建议', exact: true }).click()
  await expect(a.page.getByText(a.rationale, { exact: true })).toBeVisible()
  const aKey = `${commandPrefix}${a.userId}:${a.taskId}:${randomUUID()}`
  const bKey = `${commandPrefix}${b.userId}:${b.taskId}:${randomUUID()}`
  await a.page.evaluate(
    ({ aKey, bKey }) => {
      document.documentElement.dataset.r16Document = 'same-document'
      sessionStorage.setItem(aKey, 'A-private')
      sessionStorage.setItem(bKey, 'B-private')
    },
    { aKey, bKey },
  )
  await a.context.addCookies([
    {
      name: 'knowledgeops_session',
      value: b.token,
      url: webOrigin,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ])

  // 暂缓真实 B 的 GET 响应，观察等待期间是否错误展示缓存中的 A；不伪造业务结果。
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await a.page.route(`${apiOrigin}/workspace/entry`, async (route) => {
    const response = await route.fetch()
    await gate
    await route.fulfill({ response })
  })
  const readingB = a.page.waitForRequest(
    (request) => request.url() === `${apiOrigin}/workspace/entry`,
  )
  try {
    await a.page
      .getByRole('navigation', { name: '工作台导航' })
      .getByRole('link', { name: '学习计划', exact: true })
      .click()
    await readingB
    await expect(
      a.page.getByRole('heading', { name: '正在找回学习进度', exact: true }),
    ).toBeVisible()
    await expect(a.page.getByText(a.taskTitle, { exact: true })).toHaveCount(0)
    expect(await a.page.evaluate((key) => sessionStorage.getItem(key), aKey)).toBeNull()
    expect(await a.page.evaluate((key) => sessionStorage.getItem(key), bKey)).toBe('B-private')
    await expect(a.page.locator('html')).toHaveAttribute('data-r16-document', 'same-document')
  } finally {
    release()
  }
  await expect(
    a.page
      .getByRole('region', { name: '接下来做什么' })
      .getByRole('heading', { name: b.taskTitle, exact: true }),
  ).toBeVisible()
  await expect(a.page.getByText(a.taskTitle, { exact: true })).toHaveCount(0)
})
