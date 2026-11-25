import { randomUUID } from 'node:crypto'
import { test, expect } from './two-users.fixture.js'
import { apiOrigin, webOrigin } from './environment.js'

test('A、B 的读取接口隔离；替换资源 ID 与读取不存在资源返回相同结果', async ({
  users: { a, b },
}) => {
  for (const [actor, other] of [
    [a, b],
    [b, a],
  ] as const) {
    const session = await actor.context.request.get(`${apiOrigin}/auth/session`)
    expect(session.status()).toBe(200)
    expect(await session.json()).toMatchObject({ user: { id: actor.userId } })
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
  }
})

test('合法登录与正确版本不能取消别人的 Run；本人使用相同版本可以受理', async ({
  users: { a, b, database },
}) => {
  await database.$transaction(async (tx) => {
    for (const user of [a, b]) {
      await tx.verificationReport.delete({ where: { id: user.reportId } })
      await tx.agentRun.update({
        where: { id: user.runId },
        data: { status: 'QUEUED', version: 0, startedAt: null, finishedAt: null },
      })
      await tx.task.update({ where: { id: user.taskId }, data: { state: 'VERIFYING', version: 6 } })
    }
  })
  for (const [actor, other] of [
    [a, b],
    [b, a],
  ] as const) {
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
  }
  for (const actor of [a, b]) {
    const response = await actor.context.request.post(
      `${apiOrigin}/agent-runs/${actor.runId}/cancel`,
      {
        headers: { origin: webOrigin },
        data: { expectedRunVersion: 0 },
      },
    )
    expect(response.status()).toBe(202)
    expect(await response.json()).toMatchObject({
      runId: actor.runId,
      status: 'CANCEL_REQUESTED',
      version: 1,
    })
    expect(await database.agentRun.findUniqueOrThrow({ where: { id: actor.runId } })).toMatchObject(
      {
        status: 'CANCEL_REQUESTED',
        version: 1,
      },
    )
    expect(await database.task.findUniqueOrThrow({ where: { id: actor.taskId } })).toMatchObject({
      state: 'VERIFYING',
      version: 6,
    })
  }
  expect(
    await database.outboxEvent.count({ where: { aggregateId: { in: [a.runId, b.runId] } } }),
  ).toBe(0)
})
