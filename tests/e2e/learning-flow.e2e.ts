import { createHmac } from 'node:crypto'
import {
  planGenerationAcceptedResponseSchema,
  followUpAnswerAcceptedResponseSchema,
} from '../../packages/contracts/dist/index.js'
import {
  afterSha,
  beforeSha,
  noteContent,
  pipelinePlan,
  repositoryName,
  targetPath,
} from '../../apps/worker/test/fixtures/e2e-github-upstream.js'
import { answerRationale } from '../../apps/worker/test/fixtures/e2e-answer-worker.js'
import { test, expect } from './learning-flow.fixture.js'
import { apiOrigin, webhookSecret } from './environment.js'

test('页面生成并确认计划 → 开始任务 → Push 取证 → 笔记与回答验收 → 任务通过并解锁', async ({
  page,
  request,
  learningFlow: f,
}) => {
  const generationRunId = await test.step('通过页面创建计划，不预先写入 Task 或报告', async () => {
    expect(await f.database.learningGoal.count({ where: { userId: f.userId } })).toBe(0)
    await page.goto('/app/plan')
    await page.getByLabel('学习目标', { exact: true }).fill('R16 完整链路：事件循环学习')
    await page
      .getByLabel('当前基础', { exact: true })
      .fill('已经熟悉 Vue 和 TypeScript，希望理解微任务的执行顺序。')
    await page
      .getByLabel('截止日期', { exact: true })
      .fill(new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10))
    await page.getByLabel('每周投入（分钟）', { exact: true }).fill('600')
    await page.getByRole('radio', { name: /R16 合成模型/ }).check()
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().endsWith('/plan-generation-runs') && response.request().method() === 'POST',
    )
    await page.getByRole('button', { name: '生成计划', exact: true }).click()
    const response = await responsePromise
    expect(response.status()).toBe(202)
    const accepted = planGenerationAcceptedResponseSchema.parse(await response.json())
    await expect(page).toHaveURL((url) => url.searchParams.get('run') === accepted.generationRunId)
    await expect(page.getByRole('button', { name: '确认并开始', exact: true })).toBeVisible()
    return accepted.generationRunId
  })

  const plan = await f.database.plan.findUniqueOrThrow({
    where: { generationRunId },
    include: { stages: { include: { tasks: { orderBy: { position: 'asc' } } } } },
  })
  const [task, next, last] = plan.stages[0]!.tasks
  if (!task || !next || !last) throw new Error('Expected three generated tasks')
  expect(plan.status).toBe('DRAFT')

  await test.step('确认计划后开始根任务，后继仍须等待解锁', async () => {
    await page.getByRole('button', { name: '确认并开始', exact: true }).click()
    await expect(
      page
        .getByRole('region', { name: '接下来做什么' })
        .getByRole('heading', { name: pipelinePlan.stages[0].tasks[0].title, exact: true }),
    ).toBeVisible()
    await page.getByRole('link', { name: '查看任务', exact: true }).click()
    await expect(page).toHaveURL((url) => url.pathname === `/app/tasks/${task.id}`)
    await page.getByRole('button', { name: '开始任务', exact: true }).click()
    await expect(page.getByLabel('任务状态：进行中', { exact: true })).toBeVisible()
    expect(await f.database.task.findUniqueOrThrow({ where: { id: next.id } })).toMatchObject({
      state: 'BLOCKED',
    })
  })

  const delivery =
    await test.step('投递带签名的 Push，由真实取证消费者创建笔记验收任务', async () => {
      const body = JSON.stringify({
        installation: { id: Number(f.installationId) },
        repository: { id: Number(f.installationId) },
        ref: 'refs/heads/main',
        before: beforeSha,
        after: afterSha,
        deleted: false,
        forced: false,
      })
      const response = await request.post(`${apiOrigin}/webhooks/github`, {
        data: body,
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'push',
          'x-github-delivery': f.deliveryId,
          'x-hub-signature-256': `sha256=${createHmac('sha256', webhookSecret).update(body).digest('hex')}`,
        },
      })
      expect(response.status()).toBe(202)
      await expect
        .poll(
          async () =>
            (await f.database.webhookDelivery.findUnique({ where: { id: f.deliveryId } }))?.status,
        )
        .toBe('PROCESSED')
      const saved = await f.database.webhookDelivery.findUniqueOrThrow({
        where: { id: f.deliveryId },
        include: { submission: { include: { evidence: true } }, agentRun: true },
      })
      expect(saved).toMatchObject({
        receivedRepositoryId: f.repositoryId,
        evidenceAttemptCount: 1,
        submission: {
          taskId: task.id,
          repositoryId: f.repositoryId,
          beforeCommitSha: beforeSha,
          afterCommitSha: afterSha,
          targetPath,
          evidence: { content: noteContent, sourceCommitSha: afterSha, mode: 'DIFF' },
        },
        agentRun: { taskId: task.id, kind: 'NOTE_VERIFICATION' },
      })
      expect(saved.agentRun?.submissionId).toBe(saved.submissionId)
      expect(f.worker.githubCalls).toContain(
        `GET /repos/${repositoryName}/contents/${targetPath}?ref=${afterSha}`,
      )
      return saved
    })

  const answerRunId =
    await test.step('页面发现新报告与追问，再经现有回答流程完成验收', async () => {
      await expect(page.getByLabel('任务状态：等待回答', { exact: true })).toBeVisible()
      await page.getByRole('tab', { name: '验收与反馈' }).click()
      await expect(page.getByText('R16 合成笔记验收：通过', { exact: true })).toBeVisible()
      await page
        .getByLabel('你的回答', { exact: true })
        .fill('微任务队列需要清空，再执行后续宏任务。')
      const responsePromise = page.waitForResponse(
        (response) =>
          /\/follow-up-questions\/[^/]+\/answers$/.test(response.url()) &&
          response.request().method() === 'POST',
      )
      await page.getByRole('button', { name: '提交回答', exact: true }).click()
      const response = await responsePromise
      expect(response.status()).toBe(202)
      const accepted = followUpAnswerAcceptedResponseSchema.parse(await response.json())
      expect(accepted.taskId).toBe(task.id)
      const panel = page.getByRole('region', { name: '回答追问', exact: true })
      await expect(panel.getByText('回答结论：通过', { exact: true })).toBeVisible()
      await expect(panel.getByText(answerRationale, { exact: true })).toBeVisible()
      await expect(page.getByLabel('任务状态：已通过', { exact: true })).toBeVisible()
      // 回答必须挂在这次 Push 生成的笔记报告下，不能误用另一份已有报告。
      const answer = await f.database.answerSubmission.findUniqueOrThrow({
        where: { id: accepted.answerSubmissionId },
        include: { question: { include: { report: true } } },
      })
      expect(answer.question.report.runId).toBe(delivery.agentRunId)
      return accepted.runId
    })

  await test.step('核对四次队列交接与依赖解锁，不仅断言页面出现成功字样', async () => {
    await expect
      .poll(() =>
        f.worker.jobStates({
          generationRunId,
          deliveryId: f.deliveryId,
          noteRunId: delivery.agentRunId!,
          answerRunId,
        }),
      )
      .toEqual(['completed', 'completed', 'completed', 'completed'])
    const events = await f.database.outboxEvent.findMany({
      where: {
        aggregateId: { in: [generationRunId, f.deliveryId, delivery.agentRunId!, answerRunId] },
      },
    })
    expect(events.map((event) => event.type).sort()).toEqual(
      [
        'PLAN_GENERATION_REQUESTED',
        'GITHUB_PUSH_RECEIVED',
        'NOTE_VERIFICATION_REQUESTED',
        'ANSWER_VERIFICATION_REQUESTED',
      ].sort(),
    )
    expect(
      events.every((event) => event.dispatchedAt !== null && event.deadLetteredAt === null),
    ).toBe(true)
    expect(f.worker.answerModelCalls).toBe(1)
    await page.goto(`/app/tasks/${next.id}`)
    await expect(page.getByLabel('任务状态：可开始', { exact: true })).toBeVisible()
    // 第三项同时依赖前两项；只完成第一项不能一并解锁。
    expect(await f.database.task.findUniqueOrThrow({ where: { id: last.id } })).toMatchObject({
      state: 'BLOCKED',
    })
  })
})
