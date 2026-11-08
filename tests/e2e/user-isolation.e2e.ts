import { expandNoteResults } from './note-report.helpers.js'
import { randomUUID } from 'node:crypto'
import { test, expect } from './two-users.fixture.js'
import { apiOrigin, webOrigin } from './environment.js'

test('A、B 各自读取计划与报告；替换资源 ID 不能读取对方数据', async ({ users: { a, b } }) => {
  for (const [actor, other] of [
    [a, b],
    [b, a],
  ] as const) {
    await test.step(`确认当前会话身份及自己的页面：${actor.taskTitle}`, async () => {
      const session = await actor.context.request.get(`${apiOrigin}/auth/session`)
      expect(session.status()).toBe(200)
      expect(await session.json()).toMatchObject({ user: { id: actor.userId } })
      await actor.page.goto(`/app/tasks/${actor.taskId}?runId=${actor.runId}`)
      await expect(
        actor.page.getByRole('heading', { name: actor.taskTitle, exact: true }),
      ).toBeVisible()
      await expandNoteResults(actor.page)
      await expect(actor.page.getByText(actor.rationale, { exact: true })).toBeVisible()
      await expect(actor.page.getByText(other.rationale, { exact: true })).toHaveCount(0)
    })

    await test.step('绕过页面直接请求 API：自己的资源 200，别人的与不存在的一样返回 404', async () => {
      const reads = [
        {
          own: `/plans/${actor.planId}`,
          foreign: `/plans/${other.planId}`,
          missing: `/plans/${randomUUID()}`,
          expected: { id: actor.planId },
        },
        {
          own: `/tasks/${actor.taskId}`,
          foreign: `/tasks/${other.taskId}`,
          missing: `/tasks/${randomUUID()}`,
          expected: { id: actor.taskId, title: actor.taskTitle },
        },
        {
          own: `/agent-runs/${actor.runId}`,
          foreign: `/agent-runs/${other.runId}`,
          missing: `/agent-runs/${randomUUID()}`,
          expected: { runId: actor.runId, report: { id: actor.reportId } },
        },
        {
          own: `/agent-runs/${actor.runId}/evidence`,
          foreign: `/agent-runs/${other.runId}/evidence`,
          missing: `/agent-runs/${randomUUID()}/evidence`,
          expected: { runId: actor.runId, repositoryId: actor.repositoryId },
        },
      ]
      for (const read of reads) {
        const own = await actor.context.request.get(`${apiOrigin}${read.own}`)
        expect(own.status(), read.own).toBe(200)
        expect(await own.json()).toMatchObject(read.expected)
        const denied = await actor.context.request.get(`${apiOrigin}${read.foreign}`)
        const missing = await actor.context.request.get(`${apiOrigin}${read.missing}`)
        expect(denied.status(), read.foreign).toBe(404)
        expect(missing.status()).toBe(404)
        expect(await denied.json()).toEqual(await missing.json())
      }
    })

    await test.step('地址栏改为对方任务或把自己的任务配上对方 Run，页面不展示报告', async () => {
      const deniedResponse = actor.page.waitForResponse(
        (response) =>
          response.url() === `${apiOrigin}/tasks/${other.taskId}` &&
          response.request().method() === 'GET',
      )
      await actor.page.goto(`/app/tasks/${other.taskId}?runId=${other.runId}`)
      expect((await deniedResponse).status()).toBe(404)
      await expect(
        actor.page.getByRole('heading', { name: '任务读取失败', exact: true }),
      ).toBeVisible()
      await expect(
        actor.page.getByRole('heading', { name: other.taskTitle, exact: true }),
      ).toHaveCount(0)
      await expect(
        actor.page.getByRole('region', { name: '笔记验收报告', exact: true }),
      ).toHaveCount(0)

      await actor.page.goto(`/app/tasks/${actor.taskId}?runId=${other.runId}`)
      await expect(
        actor.page.getByRole('heading', { name: '无法选择此笔记运行', exact: true }),
      ).toBeVisible()
      await expect(actor.page.getByText(other.rationale, { exact: true })).toHaveCount(0)
      await expect(
        actor.page.getByRole('region', { name: '笔记验收报告', exact: true }),
      ).toHaveCount(0)
    })
  }
})

test('合法登录与正确版本不能取消别人的 Run；本人从页面取消可以受理', async ({
  users: { a, b, database },
}) => {
  // 本用例独立准备两份 QUEUED 夹具，不启动 Worker；观察取消受理而非取消终态。
  await database.$transaction(async (tx) => {
    for (const user of [a, b]) {
      await tx.verificationReport.delete({ where: { id: user.reportId } })
      await tx.agentRun.update({
        where: { id: user.runId },
        data: {
          status: 'QUEUED',
          version: 0,
          startedAt: null,
          finishedAt: null,
        },
      })
      await tx.task.update({ where: { id: user.taskId }, data: { state: 'VERIFYING', version: 6 } })
    }
  })
  for (const [actor, other] of [
    [a, b],
    [b, a],
  ] as const) {
    await test.step(`跨用户取消被拒绝且不改变数据库：${actor.taskTitle}`, async () => {
      const beforeRun = await database.agentRun.findUniqueOrThrow({ where: { id: other.runId } })
      const beforeTask = await database.task.findUniqueOrThrow({ where: { id: other.taskId } })
      const command = { expectedRunVersion: beforeRun.version }
      const denied = await actor.context.request.post(
        `${apiOrigin}/agent-runs/${other.runId}/cancel`,
        {
          headers: { origin: webOrigin },
          data: command,
        },
      )
      const missing = await actor.context.request.post(
        `${apiOrigin}/agent-runs/${randomUUID()}/cancel`,
        {
          headers: { origin: webOrigin },
          data: command,
        },
      )
      expect(denied.status()).toBe(404)
      expect(missing.status()).toBe(404)
      expect(await denied.json()).toEqual(await missing.json())
      expect(await database.agentRun.findUniqueOrThrow({ where: { id: other.runId } })).toEqual(
        beforeRun,
      )
      expect(await database.task.findUniqueOrThrow({ where: { id: other.taskId } })).toEqual(
        beforeTask,
      )
    })
  }
  for (const actor of [a, b]) {
    await test.step(`本人使用相同版本从页面取消能够受理：${actor.taskTitle}`, async () => {
      await actor.page.goto(`/app/tasks/${actor.taskId}?runId=${actor.runId}`)
      const accepted = actor.page.waitForResponse(
        (response) =>
          response.url() === `${apiOrigin}/agent-runs/${actor.runId}/cancel` &&
          response.request().method() === 'POST',
      )
      await actor.page.getByRole('button', { name: '取消本次验收', exact: true }).click()
      const response = await accepted
      expect(response.status()).toBe(202)
      expect(await response.json()).toMatchObject({
        runId: actor.runId,
        status: 'CANCEL_REQUESTED',
        version: 1,
      })
      await expect(actor.page.getByRole('button', { name: '正在取消', exact: true })).toBeDisabled()
      expect(
        await database.agentRun.findUniqueOrThrow({ where: { id: actor.runId } }),
      ).toMatchObject({ status: 'CANCEL_REQUESTED', version: 1 })
      expect(await database.task.findUniqueOrThrow({ where: { id: actor.taskId } })).toMatchObject({
        state: 'VERIFYING',
        version: 6,
      })
    })
  }
  expect(
    await database.outboxEvent.count({ where: { aggregateId: { in: [a.runId, b.runId] } } }),
  ).toBe(0)
})
