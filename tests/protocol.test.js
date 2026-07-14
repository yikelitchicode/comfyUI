import assert from 'node:assert/strict'
import test from 'node:test'
import {
  NODE_CLASS,
  extractProviderImage,
  imageMediaType,
  isSessionId,
  parsePromptRequest,
  parseSessionCookie
} from '../src/protocol.js'

function request(overrides = {}) {
  return {
    client_id: '43f0cb1a-5dd3-4ba2-896d-2b67fb2bf384',
    prompt: {
      '1': {
        class_type: NODE_CLASS,
        inputs: {
          prompt: 'A red paper sculpture',
          size: '1024x1024',
          quality: 'high',
          output_format: 'png'
        }
      }
    },
    extra_data: { extra_pnginfo: { workflow: {} } },
    ...overrides
  }
}

test('parses the single supported GPT Image node', () => {
  const result = parsePromptRequest(request())
  assert.equal(result.ok, true)
  assert.equal(result.value.nodeId, '1')
  assert.equal(result.value.prompt, 'A red paper sculpture')
  assert.equal(result.value.outputFormat, 'png')
})

test('rejects graphs containing unsupported nodes', () => {
  const result = parsePromptRequest(
    request({ prompt: { '1': { class_type: 'KSampler', inputs: {} } } })
  )
  assert.equal(result.ok, false)
  assert.equal(result.body.error.type, 'prompt_outputs_failed_validation')
})

test('rejects multi-node graphs and invalid image options', () => {
  const twoNodes = request()
  twoNodes.prompt['2'] = structuredClone(twoNodes.prompt['1'])
  assert.equal(parsePromptRequest(twoNodes).ok, false)

  const badSize = request()
  badSize.prompt['1'].inputs.size = '999x999'
  assert.equal(parsePromptRequest(badSize).ok, false)
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

