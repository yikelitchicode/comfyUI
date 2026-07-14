import assert from 'node:assert/strict'
import test from 'node:test'
import { parseImageRequest } from '../server/image-request.js'

test('GPT image requests use streaming', () => {
  const result = parseImageRequest({
    prompt: 'A studio photograph', model: 'gpt-image-2', size: '2048x2048', quality: 'auto', output_format: 'png'
  })
  assert.equal(result.ok, true)
  assert.equal(result.streaming, true)
  assert.equal(result.value.stream, true)
})

test('Grok image requests use non-streaming JSON', () => {
  const result = parseImageRequest({
    prompt: 'A studio photograph', model: 'grok-imagine-image', size: '2048x1152', quality: 'high', output_format: 'webp'
  })
  assert.equal(result.ok, true)
  assert.equal(result.streaming, false)
  assert.equal('stream' in result.value, false)
})

test('unsupported models and sizes are rejected', () => {
  assert.equal(parseImageRequest({ prompt: 'x', model: 'text-model', size: '2048x2048', quality: 'auto', output_format: 'png' }).ok, false)
  assert.equal(parseImageRequest({ prompt: 'x', model: 'gpt-image-2', size: '999x999', quality: 'auto', output_format: 'png' }).ok, false)
})
