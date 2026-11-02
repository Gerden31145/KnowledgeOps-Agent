import { test as base, expect, type BrowserContext, type Page } from '@playwright/test'
import { createDatabaseClient, type DatabaseClient } from '../../packages/database/dist/index.js'
import type { NoteFixtureIdentity } from '../../apps/worker/test/fixtures/verification.js'
import { createSavedNote } from './saved-note.fixture.js'
import { cleanupFixture } from './cleanup-fixture.js'
import { databaseUrl, webOrigin } from './environment.js'

type TestUser = Awaited<ReturnType<typeof createSavedNote>> & {
  context: BrowserContext
  page: Page
}
type TwoUsers = { a: TestUser; b: TestUser; database: DatabaseClient }

export const test = base.extend<{ users: TwoUsers }>({
  users: async ({ browser }, use) => {
    const database = createDatabaseClient(databaseUrl)
    const identities: NoteFixtureIdentity[] = []
    const contexts: BrowserContext[] = []
    async function createUser(label: string) {
      const note = await createSavedNote(database, (identity) => identities.push(identity), label)
      // 两个 context 分别拥有 Cookie/storage，相当于两个独立浏览器会话。
      const context = await browser.newContext({ baseURL: webOrigin })
      contexts.push(context)
      await context.addCookies([
        {
          name: 'knowledgeops_session',
          value: note.token,
          url: webOrigin,
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
        },
      ])
      return { ...note, context, page: await context.newPage() }
    }
    try {
      const a = await createUser('用户 A 的私有结果')
      const b = await createUser('用户 B 的私有结果')
      await use({ a, b, database })
    } finally {
      // 先关闭页面，防止页面轮询与清理并发；只删除本次登记的随机用户数据。
      const closed = await Promise.allSettled(contexts.map((context) => context.close()))
      try {
        const cleaned = await Promise.allSettled(
          identities.map((identity) => cleanupFixture(database, identity)),
        )
        const failures = [...closed, ...cleaned].filter((result) => result.status === 'rejected')
        expect(failures, 'R16 fixture cleanup failed').toEqual([])
      } finally {
        await database.$disconnect()
      }
    }
  },
})
export { expect }
