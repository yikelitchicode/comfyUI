import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { sessionSecret } from './config.js'

export const SESSION_COOKIE = 'comfy_session'
export const SESSION_TTL_SECONDS = 12 * 60 * 60
export const TICKET_TTL_MS = 60 * 1000

export function createLoginTicket(user) {
  return encrypt({
    purpose: 'login-ticket',
    issuedAt: Date.now(),
    expiresAt: Date.now() + TICKET_TTL_MS,
    nonce: randomBytes(16).toString('base64url'),
    user
  }, 'login-ticket')
}

export function consumeLoginTicket(value) {
  const payload = decrypt(value, 'login-ticket')
  if (payload.purpose !== 'login-ticket' || payload.expiresAt <= Date.now() || !isManagedUser(payload.user)) {
    throw new Error('The login ticket is invalid or expired.')
  }
  return payload.user
}

export function createSession(user) {
  return encrypt({
    purpose: 'session',
    expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
    user
  }, 'session')
}

export function readSession(req) {
  const value = parseCookies(req.headers.cookie || '')[SESSION_COOKIE]
  if (!value) return undefined
  try {
    const payload = decrypt(value, 'session')
    if (payload.purpose !== 'session' || payload.expiresAt <= Date.now() || !isManagedUser(payload.user)) {
      return undefined
    }
    return payload.user
  } catch {
    return undefined
  }
}

export function sessionCookie(value) {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`
}

export function expiredSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
}

function encrypt(payload, purpose) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', purposeKey(purpose), nonce)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url')
}

function decrypt(value, purpose) {
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.length < 29) throw new Error('Invalid encrypted value.')
  const nonce = bytes.subarray(0, 12)
  const tag = bytes.subarray(12, 28)
  const decipher = createDecipheriv('aes-256-gcm', purposeKey(purpose), nonce)
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')
  return JSON.parse(plaintext)
}

function purposeKey(purpose) {
  return createHash('sha256').update(`${purpose}:${sessionSecret()}`).digest()
}

function parseCookies(value) {
  return value.split(';').reduce((cookies, item) => {
    const separator = item.indexOf('=')
    if (separator <= 0) return cookies
    cookies[item.slice(0, separator).trim()] = item.slice(separator + 1).trim()
    return cookies
  }, {})
}

function isManagedUser(value) {
  return Boolean(
    value && typeof value === 'object' &&
    typeof value.userId === 'string' && value.userId &&
    typeof value.apiKey === 'string' && value.apiKey
  )
}
