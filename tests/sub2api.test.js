import assert from 'node:assert/strict'
import test from 'node:test'
import { UpstreamError, provisionManagedUser } from '../src/sub2api.js'

const ENV = {
  SUB2API_BASE_URL: 'https://chickendog.cc',
  SUB2API_IMAGE_GROUP_ID: '14'
}

test('reuses an active per-user key bound to the configured image group', async () => {
  const requests = []
  const fetcher = sequenceFetcher(requests, [
    ok({ id: 7, email: 'user@example.com', username: 'User' }),
    ok([{ id: 14, name: 'Image', is_exclusive: true, allow_image_generation: true }]),
    ok({ items: [{ key: 'sk-existing', name: 'Comfy API', status: 'active', group_id: 14 }] })
  ])

  const user = await provisionManagedUser('main-token', ENV, fetcher)

  assert.deepEqual(user, {
    userId: '7',
    email: 'user@example.com',
    displayName: 'User',
    role: 'user',
    groupId: 14,
    apiKey: 'sk-existing'
  })
  assert.equal(requests.length, 3)
  assert.equal(requests[0].init.headers.Authorization, 'Bearer main-token')
})

test('rejects users who cannot bind the configured image group', async () => {
  const fetcher = sequenceFetcher([], [
    ok({ id: 8, email: 'other@example.com' }),
    ok([{ id: 2, name: 'Default' }])
  ])

  await assert.rejects(
    () => provisionManagedUser('main-token', ENV, fetcher),
    (error) => error instanceof UpstreamError && error.status === 403 && error.code === 'image_group_unavailable'
  )
})

test('creates a group-bound key with an idempotency key when none exists', async () => {
  const requests = []
  const fetcher = sequenceFetcher(requests, [
    ok({ id: 9, email: 'new@example.com', role: 'admin' }),
    ok([{ id: 14, name: 'Image', is_exclusive: true, allow_image_generation: true }]),
    ok({ items: [] }),
    ok({ key: 'sk-created', name: 'Comfy API', status: 'active', group_id: 14 })
  ])

  const user = await provisionManagedUser('main-token', ENV, fetcher)

  assert.equal(user.apiKey, 'sk-created')
  assert.equal(user.role, 'admin')
  const createRequest = requests[3]
  assert.equal(createRequest.url.pathname, '/api/v1/keys')
  assert.equal(createRequest.init.method, 'POST')
  assert.match(createRequest.init.headers['Idempotency-Key'], /^[a-f0-9-]{36}$/u)
  assert.deepEqual(JSON.parse(createRequest.init.body), {
    name: 'Comfy API',
    group_id: 14,
    quota: 0,
    rate_limit_5h: 0,
    rate_limit_1d: 0,
    rate_limit_7d: 0
  })
})

test('fails closed when the configured group is public', async () => {
  const fetcher = sequenceFetcher([], [
    ok({ id: 10, email: 'public@example.com' }),
    ok([{ id: 14, name: 'Image', is_exclusive: false, subscription_type: 'standard', allow_image_generation: true }])
  ])

  await assert.rejects(
    () => provisionManagedUser('main-token', ENV, fetcher),
    (error) => error instanceof UpstreamError && error.status === 503 && error.code === 'image_group_not_restricted'
  )
})

function sequenceFetcher(requests, responses) {
  return async (url, init) => {
    requests.push({ url, init })
    const response = responses.shift()
    if (!response) throw new Error('Unexpected request')
    return response
  }
}

function ok(data) {
  return Response.json({ code: 0, data })
}
