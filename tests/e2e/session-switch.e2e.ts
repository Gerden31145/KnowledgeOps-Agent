import { test, expect } from './two-users.fixture.js'
import { apiOrigin, webOrigin } from './environment.js'

test('退出 A 后安装 B 会话，默认学习计划只展示 B 的数据', async ({ users: { a, b, database } }) => {
  await a.page.goto('/app/plan')
  await expect(
    a.page.getByRole('article').getByRole('heading', { name: a.taskTitle, exact: true }),
  ).toBeVisible()

  const loggedOut = a.page.waitForResponse(
    (response) =>
      response.url() === `${apiOrigin}/auth/logout` && response.request().method() === 'POST',
  )
  await a.page.getByRole('button', { name: '退出登录', exact: true }).click()
  expect((await loggedOut).status()).toBe(204)
  await expect(a.page).toHaveURL(`${webOrigin}/login`)
  expect(await database.session.count({ where: { userId: a.userId } })).toBe(0)

  await a.context.addCookies([
    {
      name: 'knowledgeops_session',
      value: b.token,
      url: webOrigin,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ])
  await a.page.goto('/app/plan')
  await expect(
    a.page.getByRole('article').getByRole('heading', { name: b.taskTitle, exact: true }),
  ).toBeVisible()
  await expect(a.page.getByText(a.taskTitle, { exact: true })).toHaveCount(0)
  await a.page.goto(`/app/tasks/${a.taskId}`)
  await expect(a.page.getByRole('heading', { name: '任务读取失败', exact: true })).toBeVisible()
})

test('同一文档内发现会话从 A 变成 B，清除 A 的 Query 缓存', async ({ users: { a, b } }) => {
  await a.page.goto(`/app/plan?plan=${a.planId}`)
  await expect(
    a.page.getByRole('article').getByRole('heading', { name: a.taskTitle, exact: true }),
  ).toBeVisible()
  await a.page.evaluate(() => {
    document.documentElement.dataset.r16Document = 'same-document'
  })
  await a.context.addCookies([
    {
      name: 'knowledgeops_session',
      value: b.token,
      url: webOrigin,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ])

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
    await expect(a.page.getByText(a.taskTitle, { exact: true })).toHaveCount(0)
    await expect(a.page.locator('html')).toHaveAttribute('data-r16-document', 'same-document')
  } finally {
    release()
  }
  await expect(
    a.page.getByRole('article').getByRole('heading', { name: b.taskTitle, exact: true }),
  ).toBeVisible()
  await expect(a.page.getByText(a.taskTitle, { exact: true })).toHaveCount(0)
})
