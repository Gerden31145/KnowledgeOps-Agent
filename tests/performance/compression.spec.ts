import { expect, test } from '@playwright/test'

test('带哈希静态资源协商 Brotli/gzip，HTML 不使用长期固定缓存', async ({ page, request }) => {
  await page.goto('/app/plan', { waitUntil: 'domcontentloaded' })
  const src = await page.locator('script[src*="/_nuxt/"]').first().getAttribute('src')
  expect(src).toBeTruthy()
  const assetUrl = new URL(src!, page.url()).toString()

  const brotli = await request.get(assetUrl, { headers: { 'accept-encoding': 'br' } })
  expect(brotli.status()).toBe(200)
  expect(brotli.headers()['content-encoding']).toBe('br')
  expect(brotli.headers()['cache-control']).toContain('immutable')
  expect(brotli.headers()['vary']).toContain('Accept-Encoding')

  const gzip = await request.get(assetUrl, { headers: { 'accept-encoding': 'gzip' } })
  expect(gzip.status()).toBe(200)
  expect(gzip.headers()['content-encoding']).toBe('gzip')
  expect(await gzip.body()).toEqual(await brotli.body())

  const identity = await request.get(assetUrl, { headers: { 'accept-encoding': 'identity' } })
  expect(identity.status()).toBe(200)
  expect(identity.headers()['content-encoding']).toBeUndefined()
  expect(await identity.body()).toEqual(await brotli.body())

  const html = await request.get('/app/plan', { headers: { 'accept-encoding': 'br' } })
  expect(html.status()).toBe(200)
  expect(html.headers()['content-type']).toContain('text/html')
  expect(html.headers()['cache-control'] ?? '').not.toContain('immutable')
})
