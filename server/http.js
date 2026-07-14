import { mainAppOrigin, publicOrigin } from './config.js'

export function json(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

export function errorResponse(res, status, code, message) {
  json(res, status, { error: { code, message } })
}

export function allowMainSiteCors(req, res) {
  const origin = requestOrigin(req)
  if (origin !== mainAppOrigin()) return false
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Vary', 'Origin')
  return true
}

export function isSameSiteMutation(req) {
  return requestOrigin(req) === publicOrigin()
}

export function bearerToken(req) {
  const header = req.headers.authorization || ''
  return header.startsWith('Bearer ') ? header.slice(7).trim() : ''
}

export async function requestBody(req) {
  if (req.body && typeof req.body === 'object') return req.body
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > 64 * 1024) throw new Error('Request body is too large.')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function requestOrigin(req) {
  try {
    return new URL(req.headers.origin || '').origin
  } catch {
    return ''
  }
}
