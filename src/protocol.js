export const NODE_CLASS = 'GPTImage2'

export const VALID_SIZES = new Set([
  '1024x1024',
  '1024x576',
  '576x1024',
  '1024x768',
  '768x1024',
  '1008x672',
  '672x1008',
  '2048x2048',
  '2048x1152',
  '1152x2048',
  '2048x1536',
  '1536x2048',
  '2016x1344',
  '1344x2016',
  '2880x2880',
  '3840x2160',
  '2160x3840',
  '2880x2160',
  '2160x2880',
  '3264x2176',
  '2176x3264'
])

export const VALID_QUALITIES = new Set(['auto', 'low', 'medium', 'high'])
export const VALID_FORMATS = new Set(['png', 'webp', 'jpeg'])

export const NODE_DEFINITIONS = {
  [NODE_CLASS]: {
    input: {
      required: {
        prompt: [
          'STRING',
          {
            default: '',
            multiline: true,
            dynamicPrompts: false,
            placeholder: 'Describe the image to generate'
          }
        ],
        size: [[...VALID_SIZES], { default: '1024x1024' }],
        quality: [[...VALID_QUALITIES], { default: 'auto' }],
        output_format: [[...VALID_FORMATS], { default: 'png' }]
      }
    },
    input_order: {
      required: ['prompt', 'size', 'quality', 'output_format']
    },
    output: [],
    output_is_list: [],
    output_name: [],
    name: NODE_CLASS,
    display_name: 'GPT Image 2',
    description: 'Generate one image through ChickenDog.cc using GPT Image 2.',
    category: 'Cloudflare',
    output_node: true,
    python_module: 'cloudflare.gpt_image',
    api_node: false
  }
}

export function parsePromptRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return invalidRequest('A JSON request body is required.')
  }

  const graph = body.prompt
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
    return invalidRequest('The prompt graph must be an object.')
  }

  const entries = Object.entries(graph)
  if (entries.length !== 1) {
    return invalidRequest('This deployment accepts exactly one GPT Image 2 node.')
  }

  const [nodeId, node] = entries[0]
  if (!node || typeof node !== 'object' || Array.isArray(node) || node.class_type !== NODE_CLASS) {
    return invalidNode(nodeId, `Only the ${NODE_CLASS} node is supported.`)
  }

  const inputs = node.inputs
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) {
    return invalidNode(nodeId, 'Node inputs are required.')
  }

  const prompt = typeof inputs.prompt === 'string' ? inputs.prompt.trim() : ''
  if (!prompt || prompt.length > 8000) {
    return invalidNode(nodeId, 'Prompt must contain between 1 and 8000 characters.')
  }

  if (typeof inputs.size !== 'string' || !VALID_SIZES.has(inputs.size)) {
    return invalidNode(nodeId, 'The selected image size is not supported.')
  }

  if (typeof inputs.quality !== 'string' || !VALID_QUALITIES.has(inputs.quality)) {
    return invalidNode(nodeId, 'The selected quality is not supported.')
  }

  if (typeof inputs.output_format !== 'string' || !VALID_FORMATS.has(inputs.output_format)) {
    return invalidNode(nodeId, 'The selected output format is not supported.')
  }

  return {
    ok: true,
    value: {
      nodeId,
      clientId: typeof body.client_id === 'string' ? body.client_id : '',
      prompt,
      size: inputs.size,
      quality: inputs.quality,
      outputFormat: inputs.output_format,
      graph,
      extraData:
        body.extra_data && typeof body.extra_data === 'object' && !Array.isArray(body.extra_data)
          ? body.extra_data
          : {}
    }
  }
}

export function extractProviderImage(payload) {
  const item = Array.isArray(payload?.data) ? payload.data[0] : undefined
  if (typeof item?.b64_json === 'string' && item.b64_json) {
    return { kind: 'base64', value: item.b64_json }
  }
  if (typeof item?.url === 'string' && item.url) {
    return { kind: 'url', value: item.url }
  }
  return undefined
}

export function imageMediaType(format) {
  return format === 'jpeg' ? 'image/jpeg' : `image/${format}`
}

export function parseSessionCookie(cookieHeader) {
  if (typeof cookieHeader !== 'string') return undefined
  for (const part of cookieHeader.split(';')) {
    const [name, ...value] = part.trim().split('=')
    if (name === 'comfy_session') return decodeURIComponent(value.join('='))
  }
  return undefined
}

export function isSessionId(value) {
  return typeof value === 'string' && /^[a-f0-9-]{20,64}$/iu.test(value)
}

function invalidRequest(message) {
  return {
    ok: false,
    status: 400,
    body: {
      error: { type: 'invalid_prompt', message, details: '' },
      node_errors: {}
    }
  }
}

function invalidNode(nodeId, message) {
  return {
    ok: false,
    status: 400,
    body: {
      error: { type: 'prompt_outputs_failed_validation', message, details: '' },
      node_errors: {
        [nodeId]: {
          errors: [{ type: 'value_invalid', message, details: '' }],
          dependent_outputs: [nodeId],
          class_type: NODE_CLASS
        }
      }
    }
  }
}

