import { expiredSessionCookie } from '../server/auth.js'
import { errorResponse, isSameSiteMutation, json } from '../server/http.js'

export default function handler(req, res) {
  if (req.method !== 'POST') return errorResponse(res, 405, 'method_not_allowed', 'Method not allowed.')
  if (!isSameSiteMutation(req)) return errorResponse(res, 403, 'origin_not_allowed', 'Cross-site requests are not allowed.')
  res.setHeader('Set-Cookie', expiredSessionCookie())
  return json(res, 200, { ok: true })
}
