import { sessionSecret } from '../server/config.js'
import { json } from '../server/http.js'

export default function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { status: 'error', error: 'method_not_allowed' })
  try {
    sessionSecret()
    return json(res, 200, { status: 'ok', sessionConfigured: true })
  } catch {
    return json(res, 503, { status: 'degraded', sessionConfigured: false })
  }
}
