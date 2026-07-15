export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024
export const MAX_SESSION_UPLOADS = 50
export const MAX_USER_ASSETS = 500
export const MAX_USER_ASSET_BYTES = 2 * 1024 * 1024 * 1024
export const TEMP_IMAGE_RETENTION_DAYS = 14

const ALLOWED_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const RESPONSES_IMAGE_COMPLETED_TYPES = new Set([
  'response.output_item.done',
  'response.completed',
  'response.done'
])

export function inspectImage(bytes, declaredType = '') {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new Error('The uploaded image is empty.')
  }
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error('The uploaded image exceeds the 20 MiB limit.')
  }

  const metadata = inspectPng(bytes) || inspectJpeg(bytes) || inspectWebp(bytes)
  if (!metadata) throw new Error('Only valid PNG, JPEG, and WebP images are supported.')
  if (declaredType && (!ALLOWED_MEDIA_TYPES.has(declaredType) || declaredType !== metadata.contentType)) {
    throw new Error('The uploaded image MIME type does not match its contents.')
  }
  if (
    !Number.isInteger(metadata.width) ||
    !Number.isInteger(metadata.height) ||
    metadata.width < 1 ||
    metadata.height < 1 ||
    metadata.width > 8192 ||
    metadata.height > 8192 ||
    metadata.width * metadata.height > 40_000_000
  ) {
    throw new Error('The uploaded image dimensions are not supported.')
  }
  return metadata
}

export function uploadFilename(originalName, extension, id) {
  const rawBase = typeof originalName === 'string'
    ? originalName.replace(/\.[^.]*$/u, '').trim()
    : ''
  const base = rawBase
    .replace(/[^A-Za-z0-9_-]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 64) || 'image'
  return `${base}_${id.slice(0, 8)}.${extension}`
}

export async function imageStreamPayload(response, completedType) {
  const completedTypes = new Set(
    (Array.isArray(completedType) ? completedType : [completedType])
      .filter((type) => typeof type === 'string' && type)
  )
  const contentType = response.headers.get('Content-Type') || ''
  if (!response.ok || !contentType.toLowerCase().includes('text/event-stream')) {
    const text = await response.text()
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      payload = undefined
    }
    if (!response.ok) {
      throw new Error(payload?.error?.message || payload?.message || `ChickenDog API failed (${response.status})`)
    }
    if (!payload) throw new Error('ChickenDog API returned an invalid image response')
    return payload
  }
  if (!response.body) throw new Error('ChickenDog API returned an empty image stream')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName = ''
  let dataLines = []
  const completedImages = []
  const completedFingerprints = new Set()
  const observedEventTypes = new Set()

  const dispatch = () => {
    if (dataLines.length === 0) {
      eventName = ''
      return
    }
    const data = dataLines.join('\n')
    dataLines = []
    const currentEvent = eventName
    eventName = ''
    if (data === '[DONE]') return

    let payload
    try {
      payload = JSON.parse(data)
    } catch {
      throw new Error('ChickenDog API returned malformed image stream data')
    }
    if (currentEvent === 'error' || payload?.type === 'error' || payload?.error) {
      throw new Error(payload?.error?.message || payload?.message || 'ChickenDog image stream failed')
    }
    const payloadType = typeof payload?.type === 'string' && payload.type
      ? payload.type
      : currentEvent
    if (typeof payloadType === 'string' && /^[A-Za-z0-9._-]{1,80}$/u.test(payloadType)) {
      observedEventTypes.add(payloadType)
    }
    if (completedTypes.has(payloadType) || RESPONSES_IMAGE_COMPLETED_TYPES.has(payloadType)) {
      for (const image of streamImageResults(payload, payloadType)) {
        const fingerprint = imageFingerprint(image)
        if (!completedFingerprints.has(fingerprint)) {
          completedFingerprints.add(fingerprint)
          completedImages.push(image)
        }
      }
    }
  }

  const processLine = (rawLine) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '') {
      dispatch()
      return
    }
    if (line.startsWith(':')) return
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim()
      return
    }
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /u, ''))
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        processLine(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
      }
    }
    buffer += decoder.decode()
    if (buffer) processLine(buffer)
    dispatch()
  } finally {
    reader.releaseLock()
  }

  if (completedImages.length === 0) {
    const observed = [...observedEventTypes].slice(-12)
    const suffix = observed.length > 0 ? `; received ${observed.join(', ')}` : ''
    throw new Error(
      `ChickenDog image stream ended without an image payload for ${[...completedTypes].join(' or ')}${suffix}`
    )
  }
  return { data: completedImages }
}

function streamImageResults(payload, payloadType = payload?.type) {
  if (payloadType === 'response.output_item.done') {
    return responseOutputItemImages(payload?.item ?? payload?.output_item)
  }
  if (payloadType === 'response.completed' || payloadType === 'response.done') {
    return responseCompletedImages(payload?.response)
  }

  const items = [payload, payload?.item]
  items.push(...(Array.isArray(payload?.output) ? payload.output : [payload?.output]))
  items.push(...(Array.isArray(payload?.data) ? payload.data : []))
  const images = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    let foundBase64 = false
    for (const field of ['b64_json', 'result', 'base64', 'image_base64']) {
      if (typeof item[field] === 'string' && item[field]) {
        images.push({ b64_json: item[field] })
        foundBase64 = true
        break
      }
    }
    if (!foundBase64 && typeof item.url === 'string' && item.url) images.push({ url: item.url })
  }
  return images
}

function responseCompletedImages(response) {
  if (!response || typeof response !== 'object' || !Array.isArray(response.output)) return []
  return response.output.flatMap(responseOutputItemImages)
}

function responseOutputItemImages(item) {
  if (!item || typeof item !== 'object' || item.type !== 'image_generation_call') return []
  const image = normalizeResponseImage(item.result)
  return image ? [{ b64_json: image }] : []
}

function normalizeResponseImage(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const image = value.trim()
  return /^data:image\/[^;,]+;base64,/iu.test(image)
    ? image.replace(/^data:image\/[^;,]+;base64,/iu, '')
    : image
}

function imageFingerprint(image) {
  const value = image.b64_json || image.url || ''
  return `${image.b64_json ? 'base64' : 'url'}:${value.length}:${value.slice(0, 48)}:${value.slice(-48)}`
}

function inspectPng(bytes) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.byteLength < 26 || !signature.every((value, index) => bytes[index] === value)) return undefined
  if (ascii(bytes, 12, 4) !== 'IHDR') return undefined
  const colorType = bytes[25]
  return {
    contentType: 'image/png',
    extension: 'png',
    width: readUint32Be(bytes, 16),
    height: readUint32Be(bytes, 20),
    hasAlpha: colorType === 4 || colorType === 6 || hasPngTransparency(bytes)
  }
}

function hasPngTransparency(bytes) {
  let offset = 8
  while (offset + 12 <= bytes.byteLength) {
    const length = readUint32Be(bytes, offset)
    if (length > bytes.byteLength - offset - 12) return false
    const type = ascii(bytes, offset + 4, 4)
    if (type === 'tRNS') return true
    if (type === 'IDAT' || type === 'IEND') return false
    offset += length + 12
  }
  return false
}

function inspectJpeg(bytes) {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
  let offset = 2
  while (offset + 4 <= bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1
    const marker = bytes[offset]
    offset += 1
    if (marker === 0xd9 || marker === 0xda) break
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.byteLength) break
    const length = readUint16Be(bytes, offset)
    if (length < 2 || offset + length > bytes.byteLength) break
    if (startOfFrame.has(marker) && length >= 7) {
      return {
        contentType: 'image/jpeg',
        extension: 'jpeg',
        width: readUint16Be(bytes, offset + 5),
        height: readUint16Be(bytes, offset + 3),
        hasAlpha: false
      }
    }
    offset += length
  }
  return undefined
}

function inspectWebp(bytes) {
  if (
    bytes.byteLength < 30 ||
    ascii(bytes, 0, 4) !== 'RIFF' ||
    ascii(bytes, 8, 4) !== 'WEBP'
  ) return undefined

  const chunk = ascii(bytes, 12, 4)
  if (chunk === 'VP8X') {
    return {
      contentType: 'image/webp',
      extension: 'webp',
      width: readUint24Le(bytes, 24) + 1,
      height: readUint24Le(bytes, 27) + 1,
      hasAlpha: (bytes[20] & 0x10) !== 0
    }
  }
  if (chunk === 'VP8L' && bytes[20] === 0x2f && bytes.byteLength >= 25) {
    const bits = readUint32Le(bytes, 21)
    return {
      contentType: 'image/webp',
      extension: 'webp',
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
      hasAlpha: (bits & 0x10000000) !== 0
    }
  }
  if (
    chunk === 'VP8 ' &&
    bytes.byteLength >= 30 &&
    bytes[23] === 0x9d &&
    bytes[24] === 0x01 &&
    bytes[25] === 0x2a
  ) {
    return {
      contentType: 'image/webp',
      extension: 'webp',
      width: readUint16Le(bytes, 26) & 0x3fff,
      height: readUint16Le(bytes, 28) & 0x3fff,
      hasAlpha: false
    }
  }
  return undefined
}

function ascii(bytes, offset, length) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

function readUint16Be(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1]
}

function readUint16Le(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8)
}

function readUint24Le(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
}

function readUint32Be(bytes, offset) {
  return ((bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0
}

function readUint32Le(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
}
