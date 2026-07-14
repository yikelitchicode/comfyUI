import { configuredModels } from './config.js'

const VALID_SIZES = new Set([
  '1024x1024', '1024x576', '576x1024', '1024x768', '768x1024', '1008x672', '672x1008',
  '2048x2048', '2048x1152', '1152x2048', '2048x1536', '1536x2048', '2016x1344', '1344x2016',
  '2880x2880', '3840x2160', '2160x3840', '2880x2160', '2160x2880', '3264x2176', '2176x3264'
])
const VALID_QUALITIES = new Set(['auto', 'low', 'medium', 'high'])
const VALID_FORMATS = new Set(['png', 'webp', 'jpeg'])

export function parseImageRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid('invalid_request', 'A JSON request body is required.')
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
  if (!prompt || prompt.length > 8000) return invalid('invalid_prompt', 'Prompt must contain between 1 and 8000 characters.')
  if (typeof input.model !== 'string' || !configuredModels().includes(input.model)) return invalid('invalid_model', 'The selected image model is not available.')
  if (typeof input.size !== 'string' || !VALID_SIZES.has(input.size)) return invalid('invalid_size', 'The selected output size is not available.')
  if (typeof input.quality !== 'string' || !VALID_QUALITIES.has(input.quality)) return invalid('invalid_quality', 'The selected quality is not available.')
  if (typeof input.output_format !== 'string' || !VALID_FORMATS.has(input.output_format)) return invalid('invalid_format', 'The selected output format is not available.')

  const grok = isGrokModel(input.model)
  return {
    ok: true,
    value: {
      model: input.model,
      prompt,
      size: input.size,
      quality: input.quality,
      output_format: input.output_format,
      response_format: 'b64_json',
      n: 1,
      ...(grok ? {} : { stream: true, partial_images: 1 })
    },
    streaming: !grok
  }
}

export function isGrokModel(model) {
  const normalized = model.trim().toLowerCase()
  return normalized === 'grok-2-image' || normalized.startsWith('grok-imagine-image')
}

function invalid(code, message) {
  return { ok: false, code, message }
}
