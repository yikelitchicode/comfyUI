import assert from 'node:assert/strict'
import test from 'node:test'
import { consumeLoginTicket, createLoginTicket, createSession, readSession, SESSION_COOKIE } from '../server/auth.js'

process.env.COMFY_SESSION_SECRET = 'test-secret-with-at-least-thirty-two-characters'

const user = { userId: '7', email: 'user@example.com', displayName: 'User', role: 'user', apiKey: 'sk-test' }

test('login tickets and sessions preserve managed user data', () => {
  assert.deepEqual(consumeLoginTicket(createLoginTicket(user)), user)
  const req = { headers: { cookie: `${SESSION_COOKIE}=${createSession(user)}` } }
  assert.deepEqual(readSession(req), user)
})

test('tampered sessions are rejected', () => {
  const req = { headers: { cookie: `${SESSION_COOKIE}=${createSession(user)}broken` } }
  assert.equal(readSession(req), undefined)
})
