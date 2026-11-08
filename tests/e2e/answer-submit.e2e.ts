import { followUpAnswerAcceptedResponseSchema } from '../../packages/contracts/dist/index.js'
import { answerRationale } from '../../apps/worker/test/fixtures/e2e-answer-worker.js'
import { test, expect } from './answer-flow.fixture.js'
import { apiOrigin, webOrigin } from './environment.js'

test('浏览器提交回答，经队列验收后任务通过、后续任务解锁；重发原命令不重复创建', async ({
  page,
  context,
  answerFlow: f,
}) => {
  await page.goto(`/app/tasks/${f.taskId}?runId=${f.noteRunId}&tab=follow-up`)
  await expect(page.getByLabel('任务状态：等待回答', { exact: true })).toBeVisible()
  await page.getByLabel('你的回答', { exact: true }).fill('微任务队列需要清空，再执行后续宏任务。')

  const submitUrl = `${apiOrigin}/follow-up-questions/${f.questionId}/answers`
  const responsePromise = page.waitForResponse(
    (response) => response.url() === submitUrl && response.request().method() === 'POST',
  )
  await page.getByRole('button', { name: '提交回答', exact: true }).click()
  const response = await responsePromise
  expect(response.status()).toBe(202)
  const accepted = followUpAnswerAcceptedResponseSchema.parse(await response.json())
  expect(accepted).toMatchObject({ status: 'ACCEPTED', taskId: f.taskId, taskVersion: 8 })
  // 保留浏览器这次真正发出的命令，后面的重放沿用同一个 requestId。
  const command: unknown = response.request().postDataJSON()

  await test.step('受理之后，等待真实 Worker 完成并由页面查询读回', async () => {
    await expect(page).toHaveURL(
      (url) => url.searchParams.get('answerId') === accepted.answerSubmissionId,
    )
    const panel = page.getByRole('region', { name: '回答追问', exact: true })
    await expect(panel.getByText('回答验收：执行完成', { exact: true })).toBeVisible()
    await expect(panel.getByText('回答结论：通过', { exact: true })).toBeVisible()
    await expect(panel.getByText(answerRationale, { exact: true })).toBeVisible()
    await expect(page.getByLabel('任务状态：已通过', { exact: true })).toBeVisible()
    await expect.poll(() => f.worker.jobState(accepted.runId)).toBe('completed')
    const event = await f.database.outboxEvent.findUniqueOrThrow({
      where: { deduplicationKey: `answer-verification-requested-${accepted.runId}` },
    })
    expect(event.dispatchedAt).not.toBeNull()
    await page.goto(`/app/tasks/${f.nextTaskId}`)
    await expect(page.getByLabel('任务状态：可开始', { exact: true })).toBeVisible()
  })

  await test.step('重发原命令仍返回同一回执，没有第二份回答、Run、报告或解锁', async () => {
    const replay = await context.request.post(submitUrl, {
      headers: { origin: webOrigin },
      data: command,
    })
    expect(replay.status()).toBe(202)
    expect(await replay.json()).toEqual(accepted)
    expect(await f.database.answerSubmission.count({ where: { questionId: f.questionId } })).toBe(1)
    expect(
      await f.database.agentRun.count({ where: { taskId: f.taskId, kind: 'ANSWER_VERIFICATION' } }),
    ).toBe(1)
    expect(
      await f.database.verificationReport.count({
        where: { run: { taskId: f.taskId, kind: 'ANSWER_VERIFICATION' } },
      }),
    ).toBe(1)
    expect(await f.database.outboxEvent.count({ where: { aggregateId: accepted.runId } })).toBe(1)
    expect(await f.database.task.findUniqueOrThrow({ where: { id: f.taskId } })).toMatchObject({
      state: 'PASSED',
      version: 9,
    })
    expect(await f.database.task.findUniqueOrThrow({ where: { id: f.nextTaskId } })).toMatchObject({
      state: 'READY',
      version: 1,
    })
    expect(f.worker.modelCalls).toBe(1)
  })
})
