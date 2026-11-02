import { followUpAnswerAcceptedResponseSchema } from '../../packages/contracts/dist/index.js'
import { answerRationale } from '../../apps/worker/test/fixtures/e2e-answer-worker.js'
import { test, expect } from './answer-flow.fixture.js'
import { apiOrigin } from './environment.js'

// 模型结果先等待，浏览器离线后再继续真实验收链路，避免完成时机的竞态。
test.use({ holdAnswerResult: true })

test('浏览器离线期间 Worker 完成回答验收，联网后自动读回原结果且不重复提交', async ({
  page,
  context,
  answerFlow: f,
}) => {
  const submitUrl = `${apiOrigin}/follow-up-questions/${f.questionId}/answers`
  const writes: string[] = []
  page.on('request', (request) => {
    if (
      request.url().startsWith(apiOrigin) &&
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())
    )
      writes.push(`${request.method()} ${request.url()}`)
  })
  const panel = page.getByRole('region', { name: '回答追问', exact: true })
  const paused = panel.getByRole('heading', { name: '网络离线，同步已暂停', exact: true })

  try {
    const accepted = await test.step('提交回答并看到运行中，模型尚未返回结果', async () => {
      await page.goto(`/app/tasks/${f.taskId}?runId=${f.noteRunId}`)
      await expect(page.getByLabel('任务状态：等待回答', { exact: true })).toBeVisible()
      await page
        .getByLabel('你的回答', { exact: true })
        .fill('微任务队列需要清空，再执行后续宏任务。')
      const responsePromise = page.waitForResponse(
        (response) => response.url() === submitUrl && response.request().method() === 'POST',
      )
      await page.getByRole('button', { name: '提交回答', exact: true }).click()
      const response = await responsePromise
      expect(response.status()).toBe(202)
      const receipt = followUpAnswerAcceptedResponseSchema.parse(await response.json())
      expect(receipt.taskId).toBe(f.taskId)
      await expect(page).toHaveURL(
        (url) => url.searchParams.get('answerId') === receipt.answerSubmissionId,
      )
      await expect(panel.getByText('回答验收：验收中', { exact: true })).toBeVisible()
      return receipt
    })
    const answerUrl = `${apiOrigin}/answer-submissions/${accepted.answerSubmissionId}`
    const readRun = () =>
      f.database.agentRun.findUniqueOrThrow({
        where: { id: accepted.runId },
        include: { report: true },
      })

    const completed = await test.step('只让浏览器离线，Worker 继续完成并保存报告', async () => {
      await context.setOffline(true)
      await expect(paused).toBeVisible()
      // 先确认未结束，避免实际测试成“完成后才断网”。
      const running = await readRun()
      expect(running.status).toBe('RUNNING')
      expect(running.report).toBeNull()
      f.releaseAnswerResult()
      // 测试进程独立读数据库；此等待不会把结果送进浏览器。
      await expect.poll(async () => (await readRun()).status).toBe('SUCCEEDED')
      const saved = await readRun()
      expect(saved.version).toBeGreaterThan(running.version)
      expect(saved.report?.runId).toBe(accepted.runId)
      expect(await f.database.task.findUniqueOrThrow({ where: { id: f.taskId } })).toMatchObject({
        state: 'PASSED',
      })
      await expect.poll(() => f.worker.jobState(accepted.runId)).toBe('completed')
      // 后台已完成，离线页面仍只能显示同步暂停，不能凭空得到结果。
      await expect(paused).toBeVisible()
      await expect(panel.getByText('回答结论：通过', { exact: true })).toHaveCount(0)
      await expect(page.getByLabel('任务状态：已通过', { exact: true })).toHaveCount(0)
      return saved
    })

    await test.step('恢复网络，自动 GET 同一份回答并更新页面', async () => {
      const responsePromise = page.waitForResponse(
        (response) => response.url() === answerUrl && response.request().method() === 'GET',
      )
      await context.setOffline(false)
      const response = await responsePromise
      expect(response.status()).toBe(200)
      expect(await response.json()).toMatchObject({
        answerSubmissionId: accepted.answerSubmissionId,
        questionId: f.questionId,
        run: { runId: accepted.runId, status: 'SUCCEEDED', version: completed.version },
        report: { id: completed.report!.id },
      })
      await expect(paused).toHaveCount(0)
      await expect(panel.getByText('回答验收：执行完成', { exact: true })).toBeVisible()
      await expect(panel.getByText('回答结论：通过', { exact: true })).toBeVisible()
      await expect(panel.getByText(answerRationale, { exact: true })).toBeVisible()
      await expect(page.getByLabel('任务状态：已通过', { exact: true })).toBeVisible()
      await expect(page).toHaveURL(
        (url) =>
          url.searchParams.get('runId') === f.noteRunId &&
          url.searchParams.get('answerId') === accepted.answerSubmissionId,
      )
    })

    await test.step('恢复只读取，没有第二次提交、调用模型或修改已完成的 Run', async () => {
      expect(writes).toEqual([`POST ${submitUrl}`])
      expect(f.worker.modelCalls).toBe(1)
      expect(await readRun()).toEqual(completed)
      expect(await f.database.answerSubmission.count({ where: { questionId: f.questionId } })).toBe(
        1,
      )
      expect(
        await f.database.agentRun.count({
          where: { taskId: f.taskId, kind: 'ANSWER_VERIFICATION' },
        }),
      ).toBe(1)
      expect(await f.database.outboxEvent.count({ where: { aggregateId: accepted.runId } })).toBe(1)
    })
  } finally {
    f.releaseAnswerResult()
    await context.setOffline(false)
  }
})
