import assert from 'node:assert/strict'
import test from 'node:test'
import {
  consumeLoginTicket,
  createLoginTicket,
  expiredSessionCookie,
  sessionCookie
} from '../src/auth.js'

const SECRET = 'test-secret-with-at-least-thirty-two-characters'
const USER = {
  userId: '42',
  email: 'user@example.com',
  displayName: 'Example User',
  role: 'user',
  groupId: 14,
  apiKey: 'sk-comfy-user-key'
}

test('round trips a short-lived encrypted login ticket', async () => {
  const ticket = await createLoginTicket(USER, SECRET, 1_000)
  assert.deepEqual(await consumeLoginTicket(ticket, SECRET, 30_000), USER)
})

test('rejects expired and modified login tickets', async () => {
  const ticket = await createLoginTicket(USER, SECRET, 1_000)
  await assert.rejects(() => consumeLoginTicket(ticket, SECRET, 61_001), /invalid or expired/u)

  const index = Math.floor(ticket.length / 2)
  const replacement = ticket[index] === 'A' ? 'B' : 'A'
  const modified = `${ticket.slice(0, index)}${replacement}${ticket.slice(index + 1)}`
  await assert.rejects(() => consumeLoginTicket(modified, SECRET, 30_000), /invalid or expired/u)
})

test('requires a strong session secret and emits secure cookies', async () => {
  await assert.rejects(() => createLoginTicket(USER, 'short'), /at least 32 characters/u)
  assert.match(sessionCookie('43f0cb1a-5dd3-4ba2-896d-2b67fb2bf384'), /HttpOnly; Secure; SameSite=Lax/u)
  assert.match(expiredSessionCookie(), /Max-Age=0/u)
})
