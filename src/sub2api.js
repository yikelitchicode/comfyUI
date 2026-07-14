const KEY_NAME = 'Comfy API'
const DEFAULT_GROUP_ID = 14

export async function provisionManagedUser(token, env, fetcher = fetch) {
  if (typeof token !== 'string' || !token.trim()) {
    throw new UpstreamError('auth_required', 'Log in to ChickenDog first.', 401)
  }

  const profile = await sub2apiRequest(token, '/api/v1/user/profile', env, fetcher)
  const userId = stringField(profile, 'id')
  if (!userId) {
    throw new UpstreamError('invalid_profile', 'ChickenDog returned an invalid user profile.', 502)
  }

  const groupId = configuredGroupId(env)
  const apiKey = await provisionImageKey(token, groupId, env, fetcher)
  return {
    userId,
    email: stringField(profile, 'email'),
    displayName:
      stringField(profile, 'username') || stringField(profile, 'name') || stringField(profile, 'email'),
    role: stringField(profile, 'role') === 'admin' ? 'admin' : 'user',
    groupId,
    apiKey
  }
}

export function configuredGroupId(env) {
  const value = Number.parseInt(env?.SUB2API_IMAGE_GROUP_ID || String(DEFAULT_GROUP_ID), 10)
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_GROUP_ID
}

async function provisionImageKey(token, groupId, env, fetcher) {
  const groups = await sub2apiRequest(token, '/api/v1/groups/available', env, fetcher)
  const group = Array.isArray(groups)
    ? groups.find((candidate) => numericField(candidate, 'id') === groupId)
    : undefined
  if (!group) {
    throw new UpstreamError('image_group_unavailable', 'Your account cannot use this image workflow.', 403)
  }
  if (!isRestrictedGroup(group)) {
    throw new UpstreamError(
      'image_group_not_restricted',
      'The configured image group must be exclusive or subscription-based.',
      503
    )
  }
  if (group.allow_image_generation !== true) {
    throw new UpstreamError(
      'image_generation_disabled',
      'Image generation is not enabled for the configured group.',
      503
    )
  }

  const keyList = await sub2apiRequest(
    token,
    `/api/v1/keys?page=1&page_size=100&group_id=${groupId}`,
    env,
    fetcher
  )
  const items = isRecord(keyList) && Array.isArray(keyList.items) ? keyList.items : []
  let key = items
    .filter(isRecord)
    .map(toApiKey)
    .find((item) => item?.status === 'active' && item.groupId === groupId && item.name === KEY_NAME)

  if (!key) {
    const created = await sub2apiRequest(
      token,
      '/api/v1/keys',
      env,
      fetcher,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID()
        },
        body: JSON.stringify({
          name: KEY_NAME,
          group_id: groupId,
          quota: 0,
          rate_limit_5h: 0,
          rate_limit_1d: 0,
          rate_limit_7d: 0
        })
      }
    )
    key = isRecord(created) ? toApiKey(created) : undefined
  }

  if (!key?.key) {
    throw new UpstreamError('image_key_unavailable', 'Could not provision the image API key.', 502)
  }
  return key.key
}

async function sub2apiRequest(token, path, env, fetcher, init = {}) {
  const base = normalizedOrigin(env?.SUB2API_BASE_URL || 'https://chickendog.cc')
  let response
  try {
    response = await fetcher(new URL(path, base), {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(15_000)
    })
  } catch {
    throw new UpstreamError('main_site_unavailable', 'ChickenDog could not be reached.', 502)
  }

  const body = await response.json().catch(() => undefined)
  if (!response.ok || !isRecord(body) || body.code !== 0) {
    const message = isRecord(body) && typeof body.message === 'string'
      ? body.message
      : `ChickenDog request failed (${response.status}).`
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

function normalizedOrigin(value) {
  return new URL(value).origin
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

function isRestrictedGroup(group) {
  return group?.is_exclusive === true || group?.subscription_type === 'subscription'
}
