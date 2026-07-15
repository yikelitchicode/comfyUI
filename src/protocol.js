export const NODE_CLASS = 'GPTImage2'
export const MAX_WORKFLOW_NODES = 20

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

const textWidget = (defaultValue, placeholder) => [
  'STRING',
  { default: defaultValue, multiline: true, dynamicPrompts: false, placeholder }
]

function definition(name, displayName, required, output, options = {}) {
  const optional = options.optional || {}
  return {
    input: Object.keys(optional).length ? { required, optional } : { required },
    input_order: Object.keys(optional).length
      ? { required: Object.keys(required), optional: Object.keys(optional) }
      : { required: Object.keys(required) },
    output,
    output_is_list: output.map(() => false),
    output_name: options.outputNames || output,
    name,
    display_name: displayName,
    description: options.description || '',
    category: options.category || 'Cloudflare',
    output_node: options.outputNode === true,
    python_module: 'cloudflare.controlled_nodes',
    api_node: false
  }
}

const generationOptions = {
  size: [[...VALID_SIZES], { default: '1024x1024' }],
  quality: [[...VALID_QUALITIES], { default: 'auto' }],
  output_format: [[...VALID_FORMATS], { default: 'png' }],
  batch_size: ['INT', { default: 1, min: 1, max: 4, step: 1 }]
}

const generationDefinition = definition('GPTImageGenerate', 'GPT Image Generate', {
  prompt: ['STRING', { forceInput: true }],
  ...generationOptions
}, ['IMAGE'], {
  outputNames: ['image'],
  description: 'Generate up to four images through ChickenDog.cc using GPT Image 2.'
})

const legacyDefinition = definition(NODE_CLASS, 'GPT Image 2 (Legacy)', {
  prompt: textWidget('', 'Describe the image to generate'),
  ...generationOptions
}, ['IMAGE'], {
  outputNames: ['image'],
  outputNode: true,
  description: 'Legacy single-node GPT Image workflow.'
})

export const NODE_REGISTRY = {
  TextPrompt: {
    definition: definition('TextPrompt', 'Text Prompt', {
      text: textWidget('', 'Enter prompt text')
    }, ['STRING'], { outputNames: ['text'], category: 'Cloudflare/Text' }),
    validate: validateTextPrompt,
    execute: async (_context, inputs) => [stringValue(inputs.text)]
  },
  TextTemplate: {
    definition: definition('TextTemplate', 'Text Template', {
      template: textWidget('{text_1}', 'Use {text_1}, {text_2}, and {text_3} placeholders'),
      text_1: ['STRING', { default: '', forceInput: true }],
      text_2: ['STRING', { default: '', forceInput: true }],
      text_3: ['STRING', { default: '', forceInput: true }]
    }, ['STRING'], { outputNames: ['text'], category: 'Cloudflare/Text' }),
    validate: validateTextTemplate,
    execute: async (_context, inputs) => [
      stringValue(
        inputs.template.replace(/\{(text_[123])\}/gu, (_match, name) => inputs[name])
      )
    ]
  },
  LoadImage: {
    definition: definition('LoadImage', 'Load Image', {
      image: [[], { image_upload: true }]
    }, ['IMAGE'], {
      outputNames: ['image'],
      category: 'Cloudflare/Image',
      description: 'Load an image from your persistent R2 workspace.'
    }),
    validate: validateUploadNode,
    execute: async (context, inputs) => [await context.loadImage(inputs.image, 'IMAGE')]
  },
  MaskImage: {
    definition: definition('MaskImage', 'Mask Image', {
      image: [[], { image_upload: true }]
    }, ['MASK'], {
      outputNames: ['mask'],
      category: 'Cloudflare/Image',
      description: 'Load an alpha-channel image to use as an edit mask.'
    }),
    validate: validateUploadNode,
    execute: async (context, inputs) => [await context.loadImage(inputs.image, 'MASK')]
  },
  GPTImageGenerate: {
    definition: generationDefinition,
    validate: validateGeneration,
    execute: async (context, inputs, node) => [await context.generateImage(inputs, node.id)]
  },
  GPTImageEdit: {
    definition: definition('GPTImageEdit', 'GPT Image Edit', {
      prompt: ['STRING', { forceInput: true }],
      image_1: ['IMAGE', { forceInput: true }],
      ...generationOptions
    }, ['IMAGE'], {
      outputNames: ['image'],
      category: 'Cloudflare/Image',
      description: 'Edit one or more reference images through GPT Image 2.',
      optional: {
        image_2: ['IMAGE', { forceInput: true }],
        image_3: ['IMAGE', { forceInput: true }],
        image_4: ['IMAGE', { forceInput: true }],
        mask: ['MASK', { forceInput: true }]
      }
    }),
    validate: validateImageEdit,
    execute: async (context, inputs, node) => [await context.editImage(inputs, node.id)]
  },
  PreviewImage: {
    definition: definition('PreviewImage', 'Preview Image', { image: ['IMAGE', {}] }, ['IMAGE'], {
      outputNames: ['image'],
      outputNode: true,
      category: 'Cloudflare/Image',
      description: 'Display an image and pass it through for use as a reference.'
    }),
    validate: validateImageSink,
    execute: async (context, inputs, node) => {
      await context.publishImage(inputs.image, node.id, 'temp')
      return [inputs.image]
    }
  },
  SaveImage: {
    definition: definition('SaveImage', 'Save Image', {
      image: ['IMAGE', {}],
      filename_prefix: ['STRING', { default: 'ComfyUI', multiline: false, dynamicPrompts: false }]
    }, ['IMAGE'], {
      outputNames: ['image'],
      outputNode: true,
      category: 'Cloudflare/Image',
      description: 'Save an image persistently and pass it through for use as a reference.'
    }),
    validate: validateSaveImage,
    execute: async (context, inputs, node) => {
      await context.publishImage(inputs.image, node.id, 'output', inputs.filename_prefix)
      return [inputs.image]
    }
  },
  [NODE_CLASS]: {
    definition: legacyDefinition,
    validate: validateGeneration,
    execute: async (context, inputs, node) => {
      const image = await context.generateImage(inputs, node.id)
      await context.publishImage(image, node.id, 'output', 'gpt-image')
      return [image]
    }
  }
}

export const NODE_DEFINITIONS = Object.fromEntries(
  Object.entries(NODE_REGISTRY).map(([name, entry]) => [name, entry.definition])
)

export function parsePromptRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return invalidRequest('A JSON request body is required.')
  }

  const graph = body.prompt
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
    return invalidRequest('The prompt graph must be an object.')
  }

  const entries = Object.entries(graph)
  if (entries.length === 0) return invalidRequest('The prompt graph must contain at least one node.')
  if (entries.length > MAX_WORKFLOW_NODES) {
    return invalidRequest(`A workflow may contain at most ${MAX_WORKFLOW_NODES} nodes.`)
  }

  const normalizedGraph = {}
  const dependencies = new Map(entries.map(([nodeId]) => [nodeId, new Set()]))
  const dependents = new Map(entries.map(([nodeId]) => [nodeId, new Set()]))
  const nodeErrors = {}

  for (const [nodeId, rawNode] of entries) {
    if (!validNodeId(nodeId) || !rawNode || typeof rawNode !== 'object' || Array.isArray(rawNode)) {
      addNodeError(nodeErrors, nodeId, rawNode?.class_type, 'Node data is invalid.')
      continue
    }

    const registryEntry = NODE_REGISTRY[rawNode.class_type]
    if (!registryEntry) {
      addNodeError(nodeErrors, nodeId, rawNode.class_type, `Node type ${rawNode.class_type || '(missing)'} is not allowed.`)
      continue
    }

    if (!rawNode.inputs || typeof rawNode.inputs !== 'object' || Array.isArray(rawNode.inputs)) {
      addNodeError(nodeErrors, nodeId, rawNode.class_type, 'Node inputs are required.')
      continue
    }

    normalizedGraph[nodeId] = {
      class_type: rawNode.class_type,
      inputs: structuredClone(rawNode.inputs)
    }
  }

  if (Object.keys(nodeErrors).length) return invalidNodes(nodeErrors)

  for (const [nodeId, node] of Object.entries(normalizedGraph)) {
    const registryEntry = NODE_REGISTRY[node.class_type]
    const required = registryEntry.definition.input.required
    const optional = registryEntry.definition.input.optional || {}
    const inputDefinitions = { ...required, ...optional }
    const allowedInputs = new Set(Object.keys(inputDefinitions))

    for (const inputName of Object.keys(node.inputs)) {
      if (!allowedInputs.has(inputName)) {
        addNodeError(nodeErrors, nodeId, node.class_type, `Input ${inputName} is not allowed.`)
      }
    }

    for (const [inputName, inputDefinition] of Object.entries(required)) {
      if (!(inputName in node.inputs)) {
        const defaultValue = inputDefinition?.[1]?.default
        if (defaultValue === undefined) {
          addNodeError(nodeErrors, nodeId, node.class_type, `Input ${inputName} is required.`)
        } else {
          node.inputs[inputName] = defaultValue
        }
        continue
      }

    }

    for (const [inputName, inputDefinition] of Object.entries(inputDefinitions)) {
      if (!(inputName in node.inputs)) continue
      const input = node.inputs[inputName]
      if (!isConnection(input)) continue
      const sourceId = String(input[0])
      const outputIndex = input[1]
      const source = normalizedGraph[sourceId]
      if (!source) {
        addNodeError(nodeErrors, nodeId, node.class_type, `Input ${inputName} references an unknown node.`)
        continue
      }
      const sourceOutputs = NODE_REGISTRY[source.class_type].definition.output
      if (outputIndex < 0 || outputIndex >= sourceOutputs.length) {
        addNodeError(nodeErrors, nodeId, node.class_type, `Input ${inputName} references an invalid output.`)
        continue
      }
      const expectedType = inputDefinition[0]
      if (sourceOutputs[outputIndex] !== expectedType) {
        addNodeError(
          nodeErrors,
          nodeId,
          node.class_type,
          `Input ${inputName} expects ${expectedType}, but the connection provides ${sourceOutputs[outputIndex]}.`
        )
        continue
      }
      dependencies.get(nodeId).add(sourceId)
      dependents.get(sourceId).add(nodeId)
    }

    for (const message of registryEntry.validate(node.inputs)) {
      addNodeError(nodeErrors, nodeId, node.class_type, message)
    }
  }

  if (Object.keys(nodeErrors).length) return invalidNodes(nodeErrors)

  const order = topologicalOrder(normalizedGraph, dependencies, dependents)
  if (!order) return invalidRequest('The prompt graph contains a cyclic dependency.')

  const outputNodeIds = order.filter((nodeId) => NODE_REGISTRY[normalizedGraph[nodeId].class_type].definition.output_node)
  if (outputNodeIds.length === 0) {
    return invalidRequest('The prompt graph must contain a Preview Image or Save Image output node.')
  }

  return {
    ok: true,
    value: {
      nodeId: outputNodeIds[0],
      outputNodeIds,
      clientId: typeof body.client_id === 'string' ? body.client_id : '',
      graph: normalizedGraph,
      order,
      extraData:
        body.extra_data && typeof body.extra_data === 'object' && !Array.isArray(body.extra_data)
          ? body.extra_data
          : {}
    }
  }
}

export async function executeWorkflow(parsed, context) {
  const outputs = new Map()
  const executed = []

  for (const nodeId of parsed.order) {
    const node = { id: nodeId, ...parsed.graph[nodeId] }
    const registryEntry = NODE_REGISTRY[node.class_type]
    if (!registryEntry) throw new Error(`Node type ${node.class_type} is not registered`)
    const inputs = resolveInputs(node, outputs)
    await context.nodeStarted?.(node)
    const nodeOutputs = await registryEntry.execute(context, inputs, node)
    if (!Array.isArray(nodeOutputs) || nodeOutputs.length !== registryEntry.definition.output.length) {
      throw new Error(`Node ${nodeId} returned an invalid output set`)
    }
    outputs.set(nodeId, nodeOutputs)
    executed.push(nodeId)
    await context.nodeCompleted?.(node, nodeOutputs)
  }

  return { outputs, executed }
}

function resolveInputs(node, outputs) {
  return Object.fromEntries(
    Object.entries(node.inputs).map(([name, input]) => {
      if (!isConnection(input)) return [name, input]
      const value = outputs.get(String(input[0]))?.[input[1]]
      if (value === undefined) throw new Error(`Node ${node.id} input ${name} is unavailable`)
      return [name, value.type === 'STRING' ? value.value : value]
    })
  )
}

function validateTextPrompt(inputs) {
  return validateString(inputs.text, 'Text', 1, 8000)
}

function validateTextTemplate(inputs) {
  const errors = validateString(inputs.template, 'Template', 1, 8000)
  for (const name of ['text_1', 'text_2', 'text_3']) {
    if (!isConnection(inputs[name])) errors.push(...validateString(inputs[name], name, 0, 8000))
  }
  return errors
}

function validateGeneration(inputs) {
  const errors = []
  if (!isConnection(inputs.prompt)) errors.push(...validateString(inputs.prompt, 'Prompt', 1, 8000))
  if (typeof inputs.size !== 'string' || !VALID_SIZES.has(inputs.size)) {
    errors.push('The selected image size is not supported.')
  }
  if (typeof inputs.quality !== 'string' || !VALID_QUALITIES.has(inputs.quality)) {
    errors.push('The selected quality is not supported.')
  }
  if (typeof inputs.output_format !== 'string' || !VALID_FORMATS.has(inputs.output_format)) {
    errors.push('The selected output format is not supported.')
  }
  if (!Number.isInteger(inputs.batch_size) || inputs.batch_size < 1 || inputs.batch_size > 4) {
    errors.push('Image count must be between 1 and 4.')
  }
  return errors
}

function validateImageEdit(inputs) {
  const errors = validateGeneration(inputs)
  if (!isConnection(inputs.image_1)) errors.push('The first reference image must be connected.')
  for (const name of ['image_2', 'image_3', 'image_4', 'mask']) {
    if (inputs[name] !== undefined && !isConnection(inputs[name])) {
      errors.push(`${name} must be connected when provided.`)
    }
  }
  return errors
}

function validateUploadNode(inputs) {
  if (typeof inputs.image !== 'string' || !/^[A-Za-z0-9_-]{1,80}\.(?:png|jpeg|webp)$/u.test(inputs.image)) {
    return ['Select a valid uploaded image.']
  }
  return []
}

function validateImageSink(inputs) {
  return isConnection(inputs.image) ? [] : ['Image must be connected to an IMAGE output.']
}

function validateSaveImage(inputs) {
  const errors = validateImageSink(inputs)
  if (!isConnection(inputs.filename_prefix)) {
    errors.push(...validateString(inputs.filename_prefix, 'Filename prefix', 1, 120))
  }
  return errors
}

function validateString(value, name, min, max) {
  if (typeof value !== 'string') return [`${name} must be text.`]
  const length = value.trim().length
  return length < min || length > max ? [`${name} must contain between ${min} and ${max} characters.`] : []
}

function topologicalOrder(graph, dependencies, dependents) {
  const remaining = new Map([...dependencies].map(([id, values]) => [id, values.size]))
  const ready = Object.keys(graph).filter((id) => remaining.get(id) === 0)
  const order = []
  for (let index = 0; index < ready.length; index += 1) {
    const nodeId = ready[index]
    order.push(nodeId)
    for (const dependentId of dependents.get(nodeId)) {
      const count = remaining.get(dependentId) - 1
      remaining.set(dependentId, count)
      if (count === 0) ready.push(dependentId)
    }
  }
  return order.length === Object.keys(graph).length ? order : undefined
}

function stringValue(value) {
  return { type: 'STRING', value }
}

function isConnection(value) {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    (typeof value[0] === 'string' || Number.isInteger(value[0])) &&
    Number.isInteger(value[1])
  )
}

function validNodeId(nodeId) {
  return typeof nodeId === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(nodeId)
}

export function extractProviderImage(payload) {
  return extractProviderImages(payload)[0]
}

export function extractProviderImages(payload) {
  if (!Array.isArray(payload?.data)) return []
  return payload.data.flatMap((item) => {
    if (typeof item?.b64_json === 'string' && item.b64_json) {
      return [{ kind: 'base64', value: item.b64_json }]
    }
    if (typeof item?.url === 'string' && item.url) return [{ kind: 'url', value: item.url }]
    return []
  })
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
    body: { error: { type: 'invalid_prompt', message, details: '' }, node_errors: {} }
  }
}

function addNodeError(errors, nodeId, classType, message) {
  const id = typeof nodeId === 'string' && nodeId ? nodeId : 'unknown'
  errors[id] ||= { errors: [], dependent_outputs: [id], class_type: classType || 'unknown' }
  errors[id].errors.push({ type: 'value_invalid', message, details: '' })
}

function invalidNodes(nodeErrors) {
  return {
    ok: false,
    status: 400,
    body: {
      error: { type: 'prompt_outputs_failed_validation', message: 'Prompt validation failed.', details: '' },
      node_errors: nodeErrors
    }
  }
}
