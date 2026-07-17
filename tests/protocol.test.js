import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_WORKFLOW_NODES,
  NODE_CLASS,
  NODE_DEFINITIONS,
  NODE_REGISTRY,
  SIZE_PRESETS,
  executeWorkflow,
  extractProviderImage,
  imageMediaType,
  isSessionId,
  parsePromptRequest,
  parseSessionCookie
} from '../src/protocol.js'

function generation(inputs = {}) {
  return {
    class_type: 'GPTImageGenerate',
    inputs: {
      prompt: 'A red paper sculpture',
      size: '1024x1024',
      quality: 'high',
      output_format: 'png',
      ...inputs
    }
  }
}

function request(prompt) {
  return {
    client_id: '43f0cb1a-5dd3-4ba2-896d-2b67fb2bf384',
    prompt,
    extra_data: { extra_pnginfo: { workflow: {} } }
  }
}

test('builds ComfyUI definitions from the controlled node registry', () => {
  assert.deepEqual(Object.keys(NODE_DEFINITIONS), Object.keys(NODE_REGISTRY))
  assert.equal(NODE_DEFINITIONS.GPTImageGenerate.output[0], 'IMAGE')
  assert.equal(NODE_DEFINITIONS.GPTImageGenerate.input.required.prompt[1].forceInput, true)
  assert.equal(NODE_DEFINITIONS.GPTImageGenerate.input.required.batch_size[1].max, 4)
  assert.equal(NODE_DEFINITIONS.GPTImageGenerate.input.required.custom_size[1].default, '')
  assert.ok(NODE_DEFINITIONS.GPTImageGenerate.input.required.size[0].includes('1080x1080 (IG Post)'))
  assert.ok(NODE_DEFINITIONS.GPTImageGenerate.input.required.size[0].includes('2480x3508 (A4 Poster, 300 DPI)'))
  assert.deepEqual(NODE_DEFINITIONS.PreviewImage.output, ['IMAGE'])
  assert.deepEqual(NODE_DEFINITIONS.SaveImage.output, ['IMAGE'])
  assert.deepEqual(NODE_DEFINITIONS[NODE_CLASS].output, ['IMAGE'])
  assert.equal(NODE_DEFINITIONS.PreviewImage.output_node, true)
  assert.equal(NODE_DEFINITIONS.SaveImage.output_node, true)
})

test('accepts labelled size presets and custom image dimensions for generation and edits', () => {
  const preset = parsePromptRequest(
    request({
      '1': generation({ size: '1200x1300 (12:13 custom ratio)' }),
      '2': { class_type: 'PreviewImage', inputs: { image: ['1', 0] } }
    })
  )
  assert.equal(preset.ok, true)
  assert.equal(preset.value.graph['1'].inputs.size, SIZE_PRESETS['1200x1300 (12:13 custom ratio)'])

  const poster = parsePromptRequest(
    request({
      '1': generation({ size: '2926x4096 (50x70 cm Poster)' }),
      '2': { class_type: 'PreviewImage', inputs: { image: ['1', 0] } }
    })
  )
  assert.equal(poster.ok, true)
  assert.equal(poster.value.graph['1'].inputs.size, SIZE_PRESETS['2926x4096 (50x70 cm Poster)'])

  const custom = parsePromptRequest(
    request({
      '1': {
        class_type: 'GPTImageEdit',
        inputs: {
          prompt: 'Extend the image',
          image_1: ['2', 0],
          size: '1024x1024',
          custom_size: '1440x1800',
          quality: 'auto',
          output_format: 'png'
        }
      },
      '2': { class_type: 'LoadImage', inputs: { image: 'reference_12345678.png' } },
      '3': { class_type: 'PreviewImage', inputs: { image: ['1', 0] } }
    })
  )
  assert.equal(custom.ok, true)
  assert.equal(custom.value.graph['1'].inputs.size, '1440x1800')
})

test('keeps legacy GPTImage2 prompts executable', () => {
  const result = parsePromptRequest(
    request({
      '1': {
        class_type: NODE_CLASS,
        inputs: {
          prompt: 'A red paper sculpture',
          size: '1024x1024',
          quality: 'high',
          output_format: 'png'
        }
      }
    })
  )
  assert.equal(result.ok, true)
  assert.equal(result.value.nodeId, '1')
  assert.equal(result.value.graph['1'].inputs.prompt, 'A red paper sculpture')
  assert.equal(result.value.graph['1'].inputs.batch_size, 1)
})

test('validates connections and topologically sorts a multi-node graph', () => {
  const result = parsePromptRequest(
    request({
      '3': { class_type: 'PreviewImage', inputs: { image: [2, 0] } },
      '2': generation({ prompt: [1, 0] }),
      '1': { class_type: 'TextPrompt', inputs: { text: 'A red paper sculpture' } }
    })
  )
  assert.equal(result.ok, true)
  assert.deepEqual(result.value.order, ['1', '2', '3'])
  assert.deepEqual(result.value.outputNodeIds, ['3'])
})

test('rejects unsupported nodes, invalid connection types, and missing outputs', () => {
  const unsupported = parsePromptRequest(
    request({ '1': { class_type: 'KSampler', inputs: {} } })
  )
  assert.equal(unsupported.ok, false)
  assert.equal(unsupported.body.error.type, 'prompt_outputs_failed_validation')

  const wrongType = parsePromptRequest(
    request({
      '1': { class_type: 'TextPrompt', inputs: { text: 'not an image' } },
      '2': { class_type: 'PreviewImage', inputs: { image: ['1', 0] } }
    })
  )
  assert.equal(wrongType.ok, false)
  assert.match(wrongType.body.node_errors['2'].errors[0].message, /expects IMAGE/u)

  const noOutput = parsePromptRequest(request({ '1': generation() }))
  assert.equal(noOutput.ok, false)
  assert.match(noOutput.body.error.message, /output node/u)
})

test('rejects cycles and workflows over the node limit', () => {
  const cyclic = parsePromptRequest(
    request({
      '1': {
        class_type: 'TextTemplate',
        inputs: { template: '{text_1}', text_1: ['2', 0], text_2: '', text_3: '' }
      },
      '2': {
        class_type: 'TextTemplate',
        inputs: { template: '{text_1}', text_1: ['1', 0], text_2: '', text_3: '' }
      },
      '3': generation({ prompt: ['1', 0] }),
      '4': { class_type: 'PreviewImage', inputs: { image: ['3', 0] } }
    })
  )
  assert.equal(cyclic.ok, false)
  assert.match(cyclic.body.error.message, /cyclic/u)

  const tooLarge = Object.fromEntries(
    Array.from({ length: MAX_WORKFLOW_NODES + 1 }, (_, index) => [
      String(index + 1),
      { class_type: 'TextPrompt', inputs: { text: `prompt ${index}` } }
    ])
  )
  const oversized = parsePromptRequest(request(tooLarge))
  assert.equal(oversized.ok, false)
  assert.match(oversized.body.error.message, /at most 20/u)
})

test('validates image batch size boundaries', () => {
  for (const batchSize of [0, 5, 1.5]) {
    const parsed = parsePromptRequest(
      request({
        '1': generation({ batch_size: batchSize }),
        '2': { class_type: 'PreviewImage', inputs: { image: ['1', 0] } }
      })
    )
    assert.equal(parsed.ok, false)
    assert.match(parsed.body.node_errors['1'].errors[0].message, /between 1 and 4/u)
  }
})

test('executes text composition, generation, preview, and save through registered handlers', async () => {
  const parsed = parsePromptRequest(
    request({
      '1': { class_type: 'TextPrompt', inputs: { text: 'Editorial portrait' } },
      '2': { class_type: 'TextPrompt', inputs: { text: 'soft window light' } },
      '3': {
        class_type: 'TextTemplate',
        inputs: {
          template: '{text_1}, {text_2}',
          text_1: ['1', 0],
          text_2: ['2', 0],
          text_3: ''
        }
      },
      '4': generation({ prompt: ['3', 0] }),
      '5': { class_type: 'PreviewImage', inputs: { image: ['4', 0] } },
      '6': {
        class_type: 'SaveImage',
        inputs: { image: ['4', 0], filename_prefix: 'Final' }
      }
    })
  )
  assert.equal(parsed.ok, true)

  const started = []
  const generated = []
  const published = []
  const image = {
    type: 'IMAGE',
    key: 'sessions/test/output/job/4.png',
    contentType: 'image/png',
    width: 1024,
    height: 1024
  }
  const result = await executeWorkflow(parsed.value, {
    nodeStarted: (node) => started.push(node.id),
    generateImage: async (inputs, nodeId) => {
      generated.push({ inputs, nodeId })
      return image
    },
    publishImage: async (...args) => published.push(args)
  })

  assert.deepEqual(started, ['1', '2', '3', '4', '5', '6'])
  assert.equal(generated[0].inputs.prompt, 'Editorial portrait, soft window light')
  assert.equal(generated[0].nodeId, '4')
  assert.deepEqual(published.map((entry) => [entry[1], entry[2], entry[3]]), [
    ['5', 'temp', undefined],
    ['6', 'output', 'Final']
  ])
  assert.deepEqual(result.executed, started)
  assert.equal(result.outputs.get('5')[0], image)
  assert.equal(result.outputs.get('6')[0], image)
})

test('connects a previewed image directly into an edit reference input', async () => {
  const parsed = parsePromptRequest(
    request({
      '1': generation(),
      '2': { class_type: 'PreviewImage', inputs: { image: ['1', 0] } },
      '3': { class_type: 'TextPrompt', inputs: { text: 'Place the subject near a window' } },
      '4': {
        class_type: 'GPTImageEdit',
        inputs: {
          prompt: ['3', 0],
          image_1: ['2', 0],
          size: '1024x1024',
          quality: 'high',
          output_format: 'png'
        }
      },
      '5': { class_type: 'SaveImage', inputs: { image: ['4', 0], filename_prefix: 'Edited' } }
    })
  )
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.value.order, ['1', '3', '2', '4', '5'])

  const source = { type: 'IMAGE', key: 'sessions/test/output/source.png' }
  const edited = { type: 'IMAGE', key: 'sessions/test/output/edited.png' }
  const editInputs = []
  const result = await executeWorkflow(parsed.value, {
    generateImage: async (_inputs, nodeId) => nodeId === '1' ? source : edited,
    editImage: async (inputs) => {
      editInputs.push(inputs)
      return edited
    },
    publishImage: async () => {}
  })

  assert.equal(editInputs[0].image_1, source)
  assert.equal(result.outputs.get('2')[0], source)
  assert.equal(result.outputs.get('5')[0], edited)
})

test('passes an image batch intact to preview and save nodes', async () => {
  const parsed = parsePromptRequest(
    request({
      '1': generation({ batch_size: 3 }),
      '2': { class_type: 'PreviewImage', inputs: { image: ['1', 0] } },
      '3': { class_type: 'SaveImage', inputs: { image: ['1', 0], filename_prefix: 'Batch' } }
    })
  )
  assert.equal(parsed.ok, true)

  const batch = {
    type: 'IMAGE',
    images: Array.from({ length: 3 }, (_, index) => ({
      type: 'IMAGE',
      key: `sessions/test/output/job/image-${index + 1}.png`,
      contentType: 'image/png',
      width: 1024,
      height: 1024
    }))
  }
  const published = []
  await executeWorkflow(parsed.value, {
    generateImage: async (inputs) => {
      assert.equal(inputs.batch_size, 3)
      return batch
    },
    publishImage: async (image, nodeId, outputType) => published.push({ image, nodeId, outputType })
  })

  assert.equal(published.length, 2)
  assert.equal(published[0].image.images.length, 3)
  assert.deepEqual(published.map((entry) => entry.outputType), ['temp', 'output'])
})

test('validates and executes multiple reference images with an optional mask', async () => {
  const parsed = parsePromptRequest(
    request({
      '1': { class_type: 'TextPrompt', inputs: { text: 'Place both products on a marble table' } },
      '2': { class_type: 'LoadImage', inputs: { image: 'product_a_12345678.png' } },
      '3': { class_type: 'LoadImage', inputs: { image: 'product_b_12345678.jpeg' } },
      '4': { class_type: 'MaskImage', inputs: { image: 'mask_12345678.png' } },
      '5': {
        class_type: 'GPTImageEdit',
        inputs: {
          prompt: ['1', 0],
          image_1: ['2', 0],
          image_2: ['3', 0],
          mask: ['4', 0],
          size: '1024x1024',
          quality: 'high',
          output_format: 'png'
        }
      },
      '6': { class_type: 'PreviewImage', inputs: { image: ['5', 0] } }
    })
  )
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.value.order, ['1', '2', '3', '4', '5', '6'])

  const edited = []
  const loaded = []
  const outputImage = {
    type: 'IMAGE',
    key: 'sessions/test/output/job/5.png',
    contentType: 'image/png',
    width: 1024,
    height: 1024
  }
  await executeWorkflow(parsed.value, {
    loadImage: async (filename, type) => {
      loaded.push({ filename, type })
      return { ...outputImage, type, filename, hasAlpha: type === 'MASK' }
    },
    editImage: async (inputs, nodeId) => {
      edited.push({ inputs, nodeId })
      return outputImage
    },
    publishImage: async () => undefined
  })
  assert.deepEqual(loaded.map((item) => item.type), ['IMAGE', 'IMAGE', 'MASK'])
  assert.equal(edited[0].inputs.prompt, 'Place both products on a marble table')
  assert.equal(edited[0].inputs.image_2.filename, 'product_b_12345678.jpeg')
  assert.equal(edited[0].inputs.mask.type, 'MASK')
})

test('rejects an IMAGE connection where GPTImageEdit expects a MASK', () => {
  const parsed = parsePromptRequest(
    request({
      '1': { class_type: 'LoadImage', inputs: { image: 'reference_12345678.png' } },
      '2': {
        class_type: 'GPTImageEdit',
        inputs: {
          prompt: 'Replace the background',
          image_1: ['1', 0],
          mask: ['1', 0],
          size: '1024x1024',
          quality: 'auto',
          output_format: 'png'
        }
      },
      '3': { class_type: 'PreviewImage', inputs: { image: ['2', 0] } }
    })
  )
  assert.equal(parsed.ok, false)
  assert.match(parsed.body.node_errors['2'].errors[0].message, /expects MASK/u)
})

test('extracts base64 and URL provider responses', () => {
  assert.deepEqual(extractProviderImage({ data: [{ b64_json: 'aGVsbG8=' }] }), {
    kind: 'base64',
    value: 'aGVsbG8='
  })
  assert.deepEqual(extractProviderImage({ data: [{ url: 'https://example.com/image.png' }] }), {
    kind: 'url',
    value: 'https://example.com/image.png'
  })
  assert.equal(extractProviderImage({ data: [] }), undefined)
})

test('handles media types and opaque session cookies', () => {
  assert.equal(imageMediaType('jpeg'), 'image/jpeg')
  assert.equal(imageMediaType('webp'), 'image/webp')
  assert.equal(
    parseSessionCookie('theme=dark; comfy_session=43f0cb1a-5dd3-4ba2-896d-2b67fb2bf384'),
    '43f0cb1a-5dd3-4ba2-896d-2b67fb2bf384'
  )
  assert.equal(isSessionId('43f0cb1a-5dd3-4ba2-896d-2b67fb2bf384'), true)
  assert.equal(isSessionId('short'), false)
})
