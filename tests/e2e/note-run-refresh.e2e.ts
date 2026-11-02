import { test, expect } from './saved-note.fixture.js'
import { apiOrigin, webOrigin } from './environment.js'

// 第一小段：真实浏览器 → HTTP/API → PostgreSQL；报告预先准备，不调用模型或 Worker。
test('刷新后从 URL 找回同一笔记 Run，并读取已保存的报告', async ({ page, savedNote }) => {
  const path = `/app/tasks/${savedNote.taskId}?runId=${savedNote.runId}`
  const runUrl = `${apiOrigin}/agent-runs/${savedNote.runId}`
  const writes: string[] = []
  page.on('request', (request) => {
    if (
      request.url().startsWith(apiOrigin) &&
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())
    )
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`)
  })

  await test.step('打开带 runId 的页面，读到数据库中的合成结果', async () => {
    await page.goto(path)
    const report = page.getByRole('region', { name: '笔记验收报告', exact: true })
    await expect(report.getByText('执行完成', { exact: true })).toBeVisible()
    await expect(report.getByText(savedNote.rationale, { exact: true })).toBeVisible()
  })

  await test.step('刷新整个页面，确认发出新的 GET 并恢复同一份报告', async () => {
    // 先订阅响应，避免请求太快时错过；等待的是条件，不是固定 sleep。
    const responsePromise = page.waitForResponse(
      (response) => response.url() === runUrl && response.request().method() === 'GET',
    )
    await page.reload()
    const response = await responsePromise
    expect(response.status()).toBe(200)
    expect(await response.json()).toMatchObject({
      runId: savedNote.runId,
      status: 'SUCCEEDED',
      version: 2,
      report: { id: savedNote.reportId },
    })
    await expect(page).toHaveURL(`${webOrigin}${path}`)
    const report = page.getByRole('region', { name: '笔记验收报告', exact: true })
    await expect(report.getByText('执行完成', { exact: true })).toBeVisible()
    await expect(report.getByText(savedNote.rationale, { exact: true })).toBeVisible()
    expect(writes).toEqual([])
  })
})
