import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import type { DatabaseClient } from '../../packages/database/dist/index.js'
import type { PlanGenerationRunStatusResponse } from '../../packages/contracts/dist/index.js'
import { test, expect } from './two-users.fixture.js'
import { apiOrigin, webOrigin } from './environment.js'

// 只用于测试观察浏览器收到的事件，不注入产品状态，也不替代 API 响应。
declare global {
  interface Window {
    r16PlanStream: {
      source: EventSource
      opened: boolean
      snapshots: PlanGenerationRunStatusResponse[]
      issue: { code: string } | null
      nativeError: boolean
    }
  }
}

async function openStream(page: Page, runId: string) {
  await page.evaluate((url) => {
    window.r16PlanStream?.source.close()
    const source = new EventSource(url, { withCredentials: true })
    const state: Window['r16PlanStream'] = {
      source,
      opened: false,
      snapshots: [],
      issue: null,
      nativeError: false,
    }
    window.r16PlanStream = state
    source.onopen = () => {
      state.opened = true
    }
    source.addEventListener('snapshot', (event) => {
      state.snapshots.push(JSON.parse(event.data))
    })
    source.addEventListener('stream-error', (event) => {
      state.issue = JSON.parse(event.data)
      source.close()
    })
    source.onerror = () => {
      // 原生 error 也会由 HTTP 401/404 触发，不能据此断定是断网。
      state.nativeError = true
      source.close()
    }
  }, `${apiOrigin}/plan-generation-runs/${runId}/events`)
}

async function createQueuedRun(database: DatabaseClient, planId: string) {
  const { goalId } = await database.plan.findUniqueOrThrow({
    where: { id: planId },
    select: { goalId: true },
  })
  // 复用夹具的 Goal；不创建 Outbox、不启动计划生成 Worker。随用户级联清理。
  return database.planGenerationRun.create({
    data: {
      goalId,
      modelCatalogId: 'r16-fixture',
      modelProvider: 'fixture',
      modelName: 'fixture',
      promptVersion: 'fixture',
      outputSchemaVersion: 'fixture',
      deadlineAt: new Date(Date.now() + 10 * 60_000),
    },
  })
}

test('真实 EventSource：本人收到快照，他人 Run 返回 404 且没有打开事件流', async ({
  users: { a, b, database },
}) => {
  const aRun = await createQueuedRun(database, a.planId)
  const bRun = await createQueuedRun(database, b.planId)
  for (const [actor, own, foreign] of [
    [a, aRun, bRun],
    [b, bRun, aRun],
  ] as const) {
    // 使用真实 Web origin，但不进入产品恢复页面，避免 HTTP 兜底掩盖 SSE 的权限结果。
    await actor.page.goto('/login')
    await test.step(`${actor.taskTitle}：合法会话可以订阅自己的 Run`, async () => {
      const response = actor.page.waitForResponse(
        `${apiOrigin}/plan-generation-runs/${own.id}/events`,
      )
      await openStream(actor.page, own.id)
      const opened = await response
      expect(opened.status()).toBe(200)
      expect(opened.headers()['content-type']).toContain('text/event-stream')
      await expect
        .poll(() => actor.page.evaluate(() => window.r16PlanStream.snapshots))
        .toEqual([
          expect.objectContaining({
            generationRunId: own.id,
            goalId: own.goalId,
            status: 'QUEUED',
            version: 0,
          }),
        ])
      expect(await actor.page.evaluate(() => window.r16PlanStream.opened)).toBe(true)
    })

    await test.step('用同一个 Cookie 请求他人的 Run，与不存在资源一样返回 404', async () => {
      const response = actor.page.waitForResponse(
        `${apiOrigin}/plan-generation-runs/${foreign.id}/events`,
      )
      await openStream(actor.page, foreign.id)
      const denied = await response
      expect(denied.status()).toBe(404)
      expect(denied.headers()['content-type']).not.toContain('text/event-stream')
      await expect
        .poll(() => actor.page.evaluate(() => window.r16PlanStream.nativeError))
        .toBe(true)
      expect(
        await actor.page.evaluate(() => ({
          opened: window.r16PlanStream.opened,
          snapshots: window.r16PlanStream.snapshots,
        })),
      ).toEqual({ opened: false, snapshots: [] })

      // EventSource 出错关闭后，Chromium 不保证仍可读取该请求的正文。
      // 浏览器行为在上面验证；错误正文另用共享同一 Cookie 的真实 HTTP 请求比较。
      const options = {
        headers: { accept: 'text/event-stream', origin: webOrigin },
        timeout: 10_000,
      }
      const [deniedHttp, missing] = await Promise.all([
        actor.context.request.get(
          `${apiOrigin}/plan-generation-runs/${foreign.id}/events`,
          options,
        ),
        actor.context.request.get(
          `${apiOrigin}/plan-generation-runs/${randomUUID()}/events`,
          options,
        ),
      ])
      expect(deniedHttp.status()).toBe(404)
      expect(missing.status()).toBe(404)
      expect(deniedHttp.headers()['content-type']).toContain('application/json')
      expect(missing.headers()['content-type']).toContain('application/json')
      expect(await deniedHttp.json()).toEqual(await missing.json())
    })
  }

  await test.step('没有登录 Cookie 时，连自己的 Run 也返回 401', async () => {
    await a.context.clearCookies()
    const response = a.page.waitForResponse(`${apiOrigin}/plan-generation-runs/${aRun.id}/events`)
    await openStream(a.page, aRun.id)
    const denied = await response
    expect(denied.status()).toBe(401)
    expect(denied.headers()['content-type']).not.toContain('text/event-stream')
    await expect.poll(() => a.page.evaluate(() => window.r16PlanStream.nativeError)).toBe(true)
    expect(await a.page.evaluate(() => window.r16PlanStream.snapshots)).toEqual([])
  })
})

test('已连接的 EventSource 在退出后收到会话失效通知，Run 的业务状态不变', async ({
  users: { a, database },
}) => {
  const run = await createQueuedRun(database, a.planId)
  await a.page.goto('/login')
  await openStream(a.page, run.id)
  await expect
    .poll(() => a.page.evaluate(() => window.r16PlanStream.snapshots))
    .toEqual([expect.objectContaining({ generationRunId: run.id, status: 'QUEUED', version: 0 })])

  // 调用真实退出 API，但刻意保持页面和 EventSource，验证服务端会复查已建立的连接。
  const logout = await a.context.request.post(`${apiOrigin}/auth/logout`, {
    headers: { origin: webOrigin },
  })
  expect(logout.status()).toBe(204)
  expect(await database.session.count({ where: { userId: a.userId } })).toBe(0)
  await expect
    .poll(() => a.page.evaluate(() => window.r16PlanStream.issue))
    .toEqual({
      code: 'UNAUTHENTICATED',
    })
  expect(
    await a.page.evaluate(() => ({
      snapshots: window.r16PlanStream.snapshots.length,
      closed: window.r16PlanStream.source.readyState === EventSource.CLOSED,
      nativeError: window.r16PlanStream.nativeError,
    })),
  ).toEqual({ snapshots: 1, closed: true, nativeError: false })
  expect(await database.planGenerationRun.findUniqueOrThrow({ where: { id: run.id } })).toEqual(run)
})
