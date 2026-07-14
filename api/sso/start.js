import { createLoginTicket } from '../../server/auth.js'
import { publicOrigin } from '../../server/config.js'
import { allowMainSiteCors, bearerToken, errorResponse, json } from '../../server/http.js'
import { provisionManagedUser, UpstreamError } from '../../server/sub2api.js'

export default async function handler(req, res) {
  if (!allowMainSiteCors(req, res)) {
    return errorResponse(res, 403, 'origin_not_allowed', 'This login request must come from the main site.')
  }
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return errorResponse(res, 405, 'method_not_allowed', 'Method not allowed.')

  const token = bearerToken(req)
  if (!token) return errorResponse(res, 401, 'auth_required', 'Log in to the main site first.')

  try {
    const user = await provisionManagedUser(token)
    const redirectUrl = new URL('/api/auth/callback', publicOrigin())
    redirectUrl.searchParams.set('ticket', createLoginTicket(user))
    return json(res, 200, { redirectUrl: redirectUrl.toString() })
  } catch (error) {
    const status = error instanceof UpstreamError ? error.status : 502
    const code = error instanceof UpstreamError ? error.code : 'sso_failed'
    return errorResponse(res, status, code, error instanceof Error ? error.message : 'Comfy login failed.')
  }
}
