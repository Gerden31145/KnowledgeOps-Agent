import { test, expect } from './answer-flow.fixture.js'
import { apiOrigin } from './environment.js'

test('追问独立页签支持键盘切换并保留未提交回答，不发送写请求', async ({ page, answerFlow: f }) => {
  const writes: string[] = []
  page.on('request', (request) => {
    if (request.url().startsWith(apiOrigin) && request.method() === 'POST')
      writes.push(request.url())
  })
  await page.goto(`/app/tasks/${f.taskId}?runId=${f.noteRunId}&tab=feedback`)
  await expect(page.getByLabel('你的回答', { exact: true })).not.toBeVisible()
  await page.getByRole('tab', { name: '验收与反馈' }).press('ArrowRight')
  await expect(page.getByRole('tab', { name: '追问回答' })).toBeFocused()
  await expect(page).toHaveURL((url) => url.searchParams.get('tab') === 'follow-up')
  await expect(page.getByRole('heading', { name: '笔记验收报告', exact: true })).toHaveCount(0)
  await page.getByLabel('你的回答', { exact: true }).fill('先清空微任务队列，再开始下一个宏任务。')
  await page.getByRole('tab', { name: '任务说明' }).click()
  await expect(page.getByLabel('你的回答', { exact: true })).not.toBeVisible()
  await page.getByRole('tab', { name: '验收与反馈' }).click()
  await expect(page.getByLabel('你的回答', { exact: true })).not.toBeVisible()
  await page.getByRole('tab', { name: '验收与反馈' }).press('End')
  await expect(page.getByRole('tab', { name: '追问回答' })).toBeFocused()
  await expect(page.getByLabel('你的回答', { exact: true })).toHaveValue(
    '先清空微任务队列，再开始下一个宏任务。',
  )
  expect(writes).toEqual([])
  await page.reload()
  await expect(page.getByRole('tab', { name: '追问回答' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByLabel('你的回答', { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: '追问回答' }).press('Home')
  await expect(page.getByRole('tab', { name: '任务说明' })).toBeFocused()
  expect(writes).toEqual([])
})
