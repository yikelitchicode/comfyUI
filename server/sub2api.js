import { imageGroupId, sub2apiBaseUrl } from './config.js'

const KEY_NAME = 'Comfy API'

export async function provisionManagedUser(token) {
  const profile = await sub2apiRequest(token, '/api/v1/user/profile')
  const userId = stringField(profile, 'id')
  if (!userId) throw new UpstreamError('invalid_profile', 'The main site returned an invalid user profile.', 502)

  const apiKey = await provisionImageKey(token)
  return {
    userId,
    email: stringField(profile, 'email'),
    displayName: stringField(profile, 'username') || stringField(profile, 'name') || stringField(profile, 'email'),
    role: stringField(profile, 'role') === 'admin' ? 'admin' : 'user',
    apiKey
  }
}

async function provisionImageKey(token) {
  const groupId = imageGroupId()
  const groups = await sub2apiRequest(token, '/api/v1/groups/available')
  if (!Array.isArray(groups) || !groups.some((group) => numericField(group, 'id') === groupId)) {
    throw new UpstreamError('image_group_unavailable', 'Your account cannot use the image group.', 403)
  }

  const keyList = await sub2apiRequest(token, `/api/v1/keys?page=1&page_size=100&group_id=${groupId}`)
  const items = isRecord(keyList) && Array.isArray(keyList.items) ? keyList.items : []
  let key = items.filter(isRecord).map(toApiKey).find((item) =>
    item && item.status === 'active' && item.groupId === groupId && item.name === KEY_NAME
  )

  if (!key) {
    const created = await sub2apiRequest(token, '/api/v1/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: KEY_NAME,
        group_id: groupId,
        quota: 0,
        rate_limit_5h: 0,
        rate_limit_1d: 0,
        rate_limit_7d: 0
      })
    })
    key = isRecord(created) ? toApiKey(created) : undefined
  }

  if (!key?.key) throw new UpstreamError('image_key_unavailable', 'Could not provision the image API key.', 502)
  return key.key
}

async function sub2apiRequest(token, path, init = {}) {
  let response
  try {
    response = await fetch(new URL(path, sub2apiBaseUrl()), {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000)
    })
  } catch {
    throw new UpstreamError('main_site_unavailable', 'The main site could not be reached.', 502)
  }
  const body = await response.json().catch(() => undefined)
  if (!response.ok || !isRecord(body) || body.code !== 0) {
    const message = isRecord(body) && typeof body.message === 'string'
      ? body.message
      : `Main site request failed (${response.status}).`
    const status = response.status === 401 ? 401 : response.status === 403 ? 403 : 502
    throw new UpstreamError('main_site_rejected', message, status)
  }
  return body.data
}

export class UpstreamError extends Error {
  constructor(code, message, status) {
    super(message)
    this.code = code
    this.status = status
  }
}

function toApiKey(value) {
  const key = stringField(value, 'key')
  if (!key) return undefined
  return {
    key,
    name: stringField(value, 'name'),
    status: stringField(value, 'status'),
    groupId: numericField(value, 'group_id')
  }
}

function stringField(value, key) {
  if (!isRecord(value)) return ''
  const field = value[key]
  return typeof field === 'string' ? field : typeof field === 'number' ? String(field) : ''
}

function numericField(value, key) {
  if (!isRecord(value)) return undefined
  const field = value[key]
  if (typeof field === 'number' && Number.isFinite(field)) return field
  if (typeof field === 'string' && field.trim()) {
    const parsed = Number(field)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
