import { test, expect } from './answer-flow.fixture.js'
import { apiOrigin } from './environment.js'

test('切换任务页签保留未提交回答，不发送写请求', async ({ page, answerFlow: f }) => {
  const writes: string[] = []
  page.on('request', (request) => {
    if (request.url().startsWith(apiOrigin) && request.method() === 'POST')
      writes.push(request.url())
  })
  await page.goto(`/app/tasks/${f.taskId}?runId=${f.noteRunId}&tab=feedback`)
  await page.getByLabel('你的回答', { exact: true }).fill('先清空微任务队列，再开始下一个宏任务。')
  await page.getByRole('tab', { name: '任务说明' }).click()
  await expect(page.getByLabel('你的回答', { exact: true })).not.toBeVisible()
  await page.getByRole('tab', { name: '验收与反馈' }).click()
  await expect(page.getByLabel('你的回答', { exact: true })).toHaveValue(
    '先清空微任务队列，再开始下一个宏任务。',
  )
  expect(writes).toEqual([])
})
