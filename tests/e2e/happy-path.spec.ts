import { test, expect } from '@playwright/test'

test('public health endpoint reports ok', async ({ request }) => {
  const res = await request.get('/api/health')
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(body.ok).toBe(true)
})

test('deferred match endpoint returns 501', async ({ request }) => {
  const res = await request.post('/api/funding-sources/match', { data: {} })
  expect(res.status()).toBe(501)
})

test('deferred enrich endpoint returns 501', async ({ request }) => {
  const res = await request.post('/api/enrich', { data: {} })
  expect(res.status()).toBe(501)
})

test('unauthenticated PATCH is rejected', async ({ request }) => {
  const res = await request.patch(
    '/api/funding-sources/00000000-0000-0000-0000-000000000000',
    { data: { rate_notes: 'unauthorized attempt' } }
  )
  expect([401, 404]).toContain(res.status())
})
