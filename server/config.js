const DEFAULT_MODELS = [
  'gpt-image-1',
  'gpt-image-1.5',
  'gpt-image-2',
  'grok-2-image',
  'grok-imagine-image',
  'grok-imagine-image-quality'
]

export function mainAppOrigin() {
  return normalizedOrigin(process.env.MAIN_APP_ORIGIN || 'https://chickendog.cc')
}

export function publicOrigin() {
  return normalizedOrigin(process.env.COMFY_PUBLIC_ORIGIN || 'https://comfyui-chi.vercel.app')
}

export function sub2apiBaseUrl() {
  return normalizedOrigin(process.env.SUB2API_BASE_URL || 'https://chickendog.cc')
}

export function imageGroupId() {
  const value = Number.parseInt(process.env.SUB2API_IMAGE_GROUP_ID || '14', 10)
  return Number.isInteger(value) && value > 0 ? value : 14
}

export function configuredModels() {
  const configured = (process.env.OPENAI_IMAGE_MODELS || '')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean)
  return [...new Set(configured.length ? configured : DEFAULT_MODELS)]
}

export function defaultModel() {
  const model = (process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2').trim()
  return configuredModels().includes(model) ? model : configuredModels()[0]
}

export function sessionSecret() {
  const secret = (process.env.COMFY_SESSION_SECRET || '').trim()
  if (secret.length < 32) {
    throw new Error('COMFY_SESSION_SECRET must contain at least 32 characters.')
  }
  return secret
}

function normalizedOrigin(value) {
  const url = new URL(value)
  return url.origin
}
