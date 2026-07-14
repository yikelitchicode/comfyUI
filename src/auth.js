const TICKET_PURPOSE = 'comfy-login-ticket-v1'
const TICKET_TTL_MS = 60 * 1000

export const SESSION_COOKIE = 'comfy_session'
export const SESSION_TTL_SECONDS = 12 * 60 * 60

export async function createLoginTicket(user, secret, now = Date.now()) {
  assertSessionSecret(secret)
  if (!isManagedUser(user)) throw new Error('Cannot create a ticket for an invalid user')

  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = new TextEncoder().encode(
    JSON.stringify({
      purpose: TICKET_PURPOSE,
      issuedAt: now,
      expiresAt: now + TICKET_TTL_MS,
      user
    })
  )
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(TICKET_PURPOSE) },
    await ticketKey(secret),
    plaintext
  )
  const token = new Uint8Array(iv.byteLength + ciphertext.byteLength)
  token.set(iv)
  token.set(new Uint8Array(ciphertext), iv.byteLength)
  return encodeBase64Url(token)
}

export async function consumeLoginTicket(ticket, secret, now = Date.now()) {
  assertSessionSecret(secret)
  try {
    const token = decodeBase64Url(ticket)
    if (token.byteLength < 29) throw new Error('Ticket is too short')
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: token.subarray(0, 12),
        additionalData: new TextEncoder().encode(TICKET_PURPOSE)
      },
      await ticketKey(secret),
      token.subarray(12)
    )
    const payload = JSON.parse(new TextDecoder().decode(plaintext))
    if (
      payload?.purpose !== TICKET_PURPOSE ||
      !Number.isFinite(payload.issuedAt) ||
      !Number.isFinite(payload.expiresAt) ||
      payload.issuedAt > now + 30_000 ||
      payload.expiresAt <= now ||
      payload.expiresAt - payload.issuedAt > TICKET_TTL_MS ||
      !isManagedUser(payload.user)
    ) {
      throw new Error('Ticket payload is invalid')
    }
    return payload.user
  } catch {
    throw new Error('The login ticket is invalid or expired')
  }
}

export function sessionCookie(sessionId) {
  return `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`
}

export function expiredSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
}

export function assertSessionSecret(secret) {
  if (typeof secret !== 'string' || secret.trim().length < 32) {
    throw new Error('COMFY_SESSION_SECRET must contain at least 32 characters')
  }
}

function isManagedUser(value) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof value.userId === 'string' &&
      value.userId &&
      typeof value.apiKey === 'string' &&
      value.apiKey &&
      Number.isInteger(value.groupId) &&
      value.groupId > 0
  )
}

async function ticketKey(secret) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret.trim()))
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

function encodeBase64Url(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function decodeBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error('Ticket is not base64url')
  }
  const padded = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}
