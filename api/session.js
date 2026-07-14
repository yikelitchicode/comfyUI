import { readSession } from '../server/auth.js'
import { configuredModels, defaultModel } from '../server/config.js'
import { errorResponse, json } from '../server/http.js'

export default function handler(req, res) {
  if (req.method !== 'GET') return errorResponse(res, 405, 'method_not_allowed', 'Method not allowed.')
  const user = readSession(req)
  if (!user) return errorResponse(res, 401, 'auth_required', 'Log in from the main site first.')
  return json(res, 200, {
    user: { userId: user.userId, email: user.email, displayName: user.displayName, role: user.role },
    models: configuredModels(),
    defaultModel: defaultModel()
  })
}
