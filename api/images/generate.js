import { readSession } from '../../server/auth.js'
import { sub2apiBaseUrl } from '../../server/config.js'
import { errorResponse, isSameSiteMutation, requestBody } from '../../server/http.js'
import { parseImageRequest } from '../../server/image-request.js'

export const maxDuration = 300

export default async function handler(req, res) {
  if (req.method !== 'POST') return errorResponse(res, 405, 'method_not_allowed', 'Method not allowed.')
  if (!isSameSiteMutation(req)) return errorResponse(res, 403, 'origin_not_allowed', 'Cross-site requests are not allowed.')
  const user = readSession(req)
  if (!user) return errorResponse(res, 401, 'auth_required', 'Log in from the main site first.')

  let input
  try {
    input = await requestBody(req)
  } catch (error) {
    return errorResponse(res, 400, 'invalid_json', error instanceof Error ? error.message : 'Invalid JSON body.')
  }
  const parsed = parseImageRequest(input)
  if (!parsed.ok) return errorResponse(res, 400, parsed.code, parsed.message)

  let upstream
  try {
    upstream = await fetch(new URL('/v1/images/generations', sub2apiBaseUrl()), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${user.apiKey}`,
        'Content-Type': 'application/json',
        Accept: parsed.streaming ? 'text/event-stream' : 'application/json'
      },
      body: JSON.stringify(parsed.value),
      signal: AbortSignal.timeout(280_000)
    })
  } catch (error) {
    const message = error instanceof Error && error.name === 'TimeoutError'
      ? 'The image provider timed out.'
      : 'The image provider could not be reached.'
    return errorResponse(res, 502, 'provider_unavailable', message)
  }

  res.statusCode = upstream.status
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Type', upstream.headers.get('content-type') || (parsed.streaming ? 'text/event-stream' : 'application/json'))
  if (!upstream.body) return res.end()

  try {
    const reader = upstream.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(Buffer.from(value))
    }
    res.end()
  } catch {
    if (!res.headersSent) return errorResponse(res, 502, 'provider_stream_failed', 'The provider response was interrupted.')
    res.end()
  }
}
