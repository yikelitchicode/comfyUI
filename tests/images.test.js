import assert from 'node:assert/strict'
import test from 'node:test'
import { imageStreamPayload, inspectImage, uploadFilename } from '../src/images.js'

function png(width, height, colorType = 6) {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  bytes.set([0, 0, 0, 13], 8)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  new DataView(bytes.buffer).setUint32(16, width)
  new DataView(bytes.buffer).setUint32(20, height)
  bytes[24] = 8
  bytes[25] = colorType
  return bytes
}

function jpeg(width, height) {
  return Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xd9
  ])
}

test('inspects real PNG dimensions and alpha from file bytes', () => {
  assert.deepEqual(inspectImage(png(1024, 768), 'image/png'), {
    contentType: 'image/png',
    extension: 'png',
    width: 1024,
    height: 768,
    hasAlpha: true
  })
  assert.equal(inspectImage(png(512, 512, 2)).hasAlpha, false)
})

test('inspects JPEG dimensions and rejects MIME spoofing and invalid data', () => {
  assert.deepEqual(inspectImage(jpeg(640, 480), 'image/jpeg'), {
    contentType: 'image/jpeg',
    extension: 'jpeg',
    width: 640,
    height: 480,
    hasAlpha: false
  })
  assert.throws(() => inspectImage(jpeg(640, 480), 'image/png'), /MIME type/u)
  assert.throws(() => inspectImage(new Uint8Array([1, 2, 3]), 'image/png'), /valid PNG/u)
})

test('creates bounded safe upload filenames', () => {
  assert.equal(
    uploadFilename('../../Reference photo.PNG', 'png', '12345678-abcd-ef01-2345-6789abcdef01'),
    'Reference_photo_12345678.png'
  )
})

test('parses chunked image SSE and ignores keepalive and partial events', async () => {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of [
        ': keepalive\n\ndata: {"type":"image_edit.partial_',
        'image","b64_json":"partial"}\n\n',
        'event: image_edit.completed\ndata: {"type":"image_edit.completed","b64_json":"final-image"}\n\n',
        'data: [DONE]\n\n'
      ]) controller.enqueue(encoder.encode(chunk))
      controller.close()
    }
  })
  const response = new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
  assert.deepEqual(await imageStreamPayload(response, 'image_edit.completed'), {
    data: [{ b64_json: 'final-image' }]
  })
})

test('accepts image generation completion events returned by image edits', async () => {
  const response = new Response(
    'event: image_generation.completed\n' +
      'data: {"type":"image_generation.completed","b64_json":"edited-image"}\n\n' +
      'data: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } }
  )

  assert.deepEqual(
    await imageStreamPayload(response, ['image_generation.completed', 'image_edit.completed']),
    { data: [{ b64_json: 'edited-image' }] }
  )
})

test('normalizes alternate completed image payload fields', async () => {
  for (const [payload, expected] of [
    [{ type: 'image_generation.completed', result: 'result-image' }, { b64_json: 'result-image' }],
    [{ type: 'image_generation.completed', output: { image_base64: 'nested-image' } }, { b64_json: 'nested-image' }],
    [{ type: 'image_generation.completed', url: 'https://example.com/image.png' }, { url: 'https://example.com/image.png' }]
  ]) {
    const response = new Response(`data: ${JSON.stringify(payload)}\n\n`, {
      headers: { 'Content-Type': 'text/event-stream' }
    })
    assert.deepEqual(
      await imageStreamPayload(response, ['image_generation.completed', 'image_edit.completed']),
      { data: [expected] }
    )
  }
})

test('collects multiple completed images in order and removes duplicate events', async () => {
  const first = { type: 'image_generation.completed', b64_json: 'first-image' }
  const second = { type: 'image_generation.completed', result: 'second-image' }
  const response = new Response(
    [first, first, second].map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join(''),
    { headers: { 'Content-Type': 'text/event-stream' } }
  )

  assert.deepEqual(await imageStreamPayload(response, 'image_generation.completed'), {
    data: [{ b64_json: 'first-image' }, { b64_json: 'second-image' }]
  })
})

test('collects image arrays from one completed event', async () => {
  const response = new Response(
    'data: {"type":"image_generation.completed","data":' +
      '[{"b64_json":"first-image"},{"b64_json":"second-image"}]}\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } }
  )

  assert.deepEqual(await imageStreamPayload(response, 'image_generation.completed'), {
    data: [{ b64_json: 'first-image' }, { b64_json: 'second-image' }]
  })
})

test('accepts Responses API output item completion events', async () => {
  const response = new Response(
    'event: response.output_item.done\n' +
      'data: {"type":"response.output_item.done","item":' +
      '{"type":"image_generation_call","result":"responses-image"}}\n\n' +
      'data: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } }
  )

  assert.deepEqual(await imageStreamPayload(response, 'image_generation.completed'), {
    data: [{ b64_json: 'responses-image' }]
  })
})

test('accepts Responses API completion events and removes duplicate output items', async () => {
  const outputItem = { type: 'image_generation_call', result: 'data:image/png;base64,responses-image' }
  const response = new Response(
    'event: response.output_item.done\n' +
      `data: ${JSON.stringify({ item: outputItem })}\n\n` +
      'event: response.completed\n' +
      `data: ${JSON.stringify({ response: { output: [outputItem] } })}\n\n`,
    { headers: { 'Content-Type': 'text/event-stream' } }
  )

  assert.deepEqual(await imageStreamPayload(response, 'image_edit.completed'), {
    data: [{ b64_json: 'responses-image' }]
  })
})

test('accepts response.done image completion events', async () => {
  const response = new Response(
    'data: {"type":"response.done","response":{"output":[' +
      '{"type":"image_generation_call","result":"done-image"}]}}\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } }
  )

  assert.deepEqual(await imageStreamPayload(response, 'image_edit.completed'), {
    data: [{ b64_json: 'done-image' }]
  })
})

test('reports observed SSE event types when no completed image is found', async () => {
  const response = new Response(
    'data: {"type":"response.created"}\n\n' +
      'data: {"type":"response.done","response":{"output":[]}}\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } }
  )

  await assert.rejects(
    () => imageStreamPayload(response, 'image_edit.completed'),
    /received response\.created, response\.done/u
  )
})

test('supports JSON fallback and exposes streaming errors', async () => {
  const fallback = new Response(JSON.stringify({ data: [{ b64_json: 'fallback' }] }), {
    headers: { 'Content-Type': 'application/json' }
  })
  assert.deepEqual(await imageStreamPayload(fallback, 'image_generation.completed'), {
    data: [{ b64_json: 'fallback' }]
  })

  const streamError = new Response('event: error\ndata: {"error":{"message":"upstream unavailable"}}\n\n', {
    headers: { 'Content-Type': 'text/event-stream' }
  })
  await assert.rejects(() => imageStreamPayload(streamError, 'image_edit.completed'), /upstream unavailable/u)

  const incomplete = new Response('data: {"type":"image_edit.partial_image","b64_json":"partial"}\n\n', {
    headers: { 'Content-Type': 'text/event-stream' }
  })
  await assert.rejects(() => imageStreamPayload(incomplete, 'image_edit.completed'), /ended without/u)
})
