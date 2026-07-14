import { consumeLoginTicket, createSession, sessionCookie } from '../../server/auth.js'
import { publicOrigin } from '../../server/config.js'

export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end('Method not allowed')
  try {
    const ticket = typeof req.query?.ticket === 'string' ? req.query.ticket : ''
    const user = consumeLoginTicket(ticket)
    res.setHeader('Set-Cookie', sessionCookie(createSession(user)))
    res.setHeader('Cache-Control', 'no-store')
    return res.redirect(302, publicOrigin())
  } catch {
    return res.redirect(302, `${publicOrigin()}/?auth_error=expired_ticket`)
  }
}
