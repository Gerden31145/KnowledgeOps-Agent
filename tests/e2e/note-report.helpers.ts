import { expect, type Page } from '@playwright/test'

// 报告默认折叠，回归用例通过真实点击查看理由，不用隐藏文字代替可见结果。
export async function expandNoteResults(page: Page) {
  const results = page.getByRole('list', { name: '逐项验收结果', exact: true })
  await expect(results).toBeVisible()
  // 遍历稳定的条目集合；不能按 :not([open]) 的动态 nth 索引点击，否则展开后索引会移动。
  for (const detail of await results.locator(':scope > li > details').all()) {
    if ((await detail.getAttribute('open')) === null)
      await detail.locator(':scope > summary').click()
  }
}
