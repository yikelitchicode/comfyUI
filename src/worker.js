import { DurableObject } from 'cloudflare:workers'
import {
  NODE_CLASS,
  NODE_DEFINITIONS,
  extractProviderImage,
  imageMediaType,
  isSessionId,
  parsePromptRequest,
  parseSessionCookie
} from './protocol.js'

const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 30

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (url.pathname === '/api/health') {
      return json({
        ok: true,
        provider: env.CHICKENDOG_API_BASE || 'https://chickendog.cc/v1',
        model: env.IMAGE_MODEL || 'gpt-image-2',
        configured: Boolean(env.CHICKENDOG_API_KEY)
      })
    }

    if (url.pathname !== '/ws' && !url.pathname.startsWith('/api/')) {
      return json({ error: 'Not found' }, 404)
    }

    if (!originAllowed(request, env.ALLOWED_ORIGIN)) {
      return json({ error: 'Origin not allowed' }, 403)
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204 })
    }

    let sessionId = sessionFromRequest(request, url)
    if (url.pathname === '/api/prompt' && request.method === 'POST') {
      const body = await request.clone().json().catch(() => undefined)
      if (isSessionId(body?.client_id)) sessionId = body.client_id
    }

    const createdSession = !sessionId
    sessionId ||= crypto.randomUUID()

    const id = env.COMFY_SESSIONS.idFromName(sessionId)
    const stub = env.COMFY_SESSIONS.get(id)
    const headers = new Headers(request.headers)
    headers.set('X-Comfy-Session', sessionId)
    const response = await stub.fetch(new Request(request, { headers }))

    if (!createdSession) return response

    const responseHeaders = new Headers(response.headers)
    responseHeaders.append(
      'Set-Cookie',
      `comfy_session=${encodeURIComponent(sessionId)}; Path=/; Max-Age=${SESSION_COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`
    )
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      webSocket: response.webSocket
    })
  }
}

export class ComfySession extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    this.ctx = ctx
    this.env = env
    this.sql = ctx.storage.sql
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER,
        node_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        extra_data TEXT NOT NULL,
        output_key TEXT,
        output_filename TEXT,
        media_type TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS jobs_status_created_idx ON jobs(status, created_at);
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
    this.sql.exec("UPDATE jobs SET status = 'pending', started_at = NULL WHERE status = 'in_progress'")
  }

  async fetch(request) {
    const url = new URL(request.url)
    const sessionId = request.headers.get('X-Comfy-Session')
    if (isSessionId(sessionId)) {
      this.sql.exec(
        'INSERT INTO metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        'session_id',
        sessionId
      )
    }

    try {
      if (url.pathname === '/ws') return this.openWebSocket(request)
      if (url.pathname === '/api/object_info' && request.method === 'GET') return json(NODE_DEFINITIONS)
      if (url.pathname === `/api/object_info/${NODE_CLASS}` && request.method === 'GET') {
        return json(NODE_DEFINITIONS[NODE_CLASS])
      }
      if (url.pathname === '/api/prompt' && request.method === 'GET') return this.promptStatus()
      if (url.pathname === '/api/prompt' && request.method === 'POST') return this.enqueue(request)
      if (url.pathname === '/api/queue' && request.method === 'GET') return this.legacyQueue()
      if (url.pathname === '/api/queue' && request.method === 'POST') return this.manageQueue(request)
      if (url.pathname === '/api/jobs' && request.method === 'GET') return this.listJobs(url)
      if (url.pathname.startsWith('/api/jobs/') && request.method === 'GET') {
        return this.jobDetail(decodeURIComponent(url.pathname.slice('/api/jobs/'.length)))
      }
      if (url.pathname === '/api/history' && request.method === 'GET') return this.legacyHistory(url)
      if (url.pathname === '/api/history' && request.method === 'POST') return this.manageHistory(request)
      if (url.pathname.startsWith('/api/history/') && request.method === 'GET') {
        return this.legacyHistoryDetail(decodeURIComponent(url.pathname.slice('/api/history/'.length)))
      }
      if (url.pathname === '/api/view' && request.method === 'GET') return this.viewImage(url)
      if (url.pathname === '/api/settings') return this.settings(request)
      return staticApiResponse(url, request.method)
    } catch (error) {
      console.error('Comfy API request failed', error)
      return json({ error: errorMessage(error) }, 500)
    }
  }

  webSocketMessage(_socket, message) {
    if (typeof message !== 'string') return
    try {
      const parsed = JSON.parse(message)
      if (parsed?.type === 'feature_flags') {
        this.broadcast({ type: 'feature_flags', data: serverFeatureFlags() })
      }
    } catch {
      // Client extension messages are optional and must not close the socket.
    }
  }

  webSocketClose(socket, code, reason) {
    try {
      socket.close(code, reason)
    } catch {
      // The peer may already have completed the closing handshake.
    }
  }

  async alarm() {
    const running = this.firstRow(
      "SELECT * FROM jobs WHERE status = 'in_progress' ORDER BY created_at LIMIT 1"
    )
    if (running) return

    const job = this.firstRow("SELECT * FROM jobs WHERE status = 'pending' ORDER BY created_at LIMIT 1")
    if (!job) {
      this.broadcastStatus()
      return
    }

    const startedAt = Date.now()
    this.sql.exec("UPDATE jobs SET status = 'in_progress', started_at = ? WHERE id = ?", startedAt, job.id)
    this.broadcast({ type: 'execution_start', data: { prompt_id: job.id, timestamp: startedAt } })
    this.broadcast({ type: 'executing', data: { node: job.node_id, prompt_id: job.id } })
    this.broadcastStatus()

    try {
      const graph = JSON.parse(job.prompt)
      const inputs = graph[job.node_id].inputs
      const output = await this.generateImage(job.id, inputs)
      const endedAt = Date.now()
      this.sql.exec(
        `UPDATE jobs
         SET status = 'completed', ended_at = ?, output_key = ?, output_filename = ?, media_type = ?
         WHERE id = ?`,
        endedAt,
        output.key,
        output.filename,
        output.mediaType,
        job.id
      )

      const result = imageOutput(output.filename)
      this.broadcast({
        type: 'executed',
        data: { node: job.node_id, display_node: job.node_id, output: result, prompt_id: job.id }
      })
      this.broadcast({ type: 'execution_success', data: { prompt_id: job.id, timestamp: endedAt } })
    } catch (error) {
      const endedAt = Date.now()
      const message = errorMessage(error).slice(0, 2000)
      this.sql.exec(
        "UPDATE jobs SET status = 'failed', ended_at = ?, error = ? WHERE id = ?",
        endedAt,
        message,
        job.id
      )
      this.broadcast({
        type: 'execution_error',
        data: {
          prompt_id: job.id,
          node_id: job.node_id,
          node_type: NODE_CLASS,
          executed: [],
          exception_message: message,
          exception_type: 'ProviderError',
          traceback: [],
          current_inputs: {},
          current_outputs: {},
          timestamp: endedAt
        }
      })
    } finally {
      this.broadcast({ type: 'executing', data: { node: null } })
      await this.trimHistory()
      this.broadcastStatus()
      if (this.pendingCount() > 0) await this.ctx.storage.setAlarm(Date.now() + 100)
    }
  }

  openWebSocket(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return json({ error: 'Expected a WebSocket upgrade' }, 426)
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    this.ctx.acceptWebSocket(server)
    server.send(
      JSON.stringify({
        type: 'status',
        data: {
          status: { exec_info: { queue_remaining: this.pendingCount() } },
          sid: this.sessionId()
        }
      })
    )
    server.send(JSON.stringify({ type: 'feature_flags', data: serverFeatureFlags() }))
    return new Response(null, { status: 101, webSocket: client })
  }

  async enqueue(request) {
    const length = Number(request.headers.get('Content-Length') || 0)
    if (length > 1_000_000) return json({ error: 'Workflow JSON is too large' }, 413)

    const body = await request.json().catch(() => undefined)
    const parsed = parsePromptRequest(body)
    if (!parsed.ok) return json(parsed.body, parsed.status)

    const maxQueue = clampInteger(this.env.MAX_QUEUE, 1, 20, 3)
    if (this.pendingCount() >= maxQueue) {
      return json(
        {
          error: {
            type: 'queue_full',
            message: `This session already has ${maxQueue} pending jobs.`,
            details: ''
          },
          node_errors: {}
        },
        429
      )
    }

    const promptId = crypto.randomUUID()
    const createdAt = Date.now()
    const value = parsed.value
    const normalizedGraph = structuredClone(value.graph)
    normalizedGraph[value.nodeId].inputs = {
      prompt: value.prompt,
      size: value.size,
      quality: value.quality,
      output_format: value.outputFormat
    }
    this.sql.exec(
      `INSERT INTO jobs(id, status, created_at, node_id, prompt, extra_data)
       VALUES (?, 'pending', ?, ?, ?, ?)`,
      promptId,
      createdAt,
      value.nodeId,
      JSON.stringify(normalizedGraph),
      JSON.stringify(value.extraData)
    )

    await this.ctx.storage.setAlarm(Date.now() + 50)
    this.broadcast({ type: 'promptQueued', data: { prompt_id: promptId } })
    this.broadcastStatus()
    return json({ prompt_id: promptId, number: createdAt, node_errors: {} })
  }

  promptStatus() {
    return json({ exec_info: { queue_remaining: this.pendingCount() } })
  }

  legacyQueue() {
    const running = this.rows("SELECT * FROM jobs WHERE status = 'in_progress' ORDER BY created_at")
    const pending = this.rows("SELECT * FROM jobs WHERE status = 'pending' ORDER BY created_at")
    return json({
      queue_running: running.map(legacyQueueItem),
      queue_pending: pending.map(legacyQueueItem)
    })
  }

  async manageQueue(request) {
    const body = await request.json().catch(() => ({}))
    const deleted = []
    if (Array.isArray(body.delete)) {
      for (const id of body.delete) {
        if (typeof id !== 'string') continue
        const result = this.sql.exec(
          "UPDATE jobs SET status = 'cancelled', ended_at = ? WHERE id = ? AND status = 'pending'",
          Date.now(),
          id
        )
        if (result.rowsWritten > 0) deleted.push(id)
      }
    }
    if (body.clear === true) {
      this.sql.exec("UPDATE jobs SET status = 'cancelled', ended_at = ? WHERE status = 'pending'", Date.now())
    }
    this.broadcastStatus()
    return json({ deleted, cleared: body.clear === true })
  }

  listJobs(url) {
    const allowed = new Set(['pending', 'in_progress', 'completed', 'failed', 'cancelled'])
    const requested = (url.searchParams.get('status') || '')
      .split(',')
      .filter((status) => allowed.has(status))
    const statuses = requested.length ? requested : [...allowed]
    const limit = clampInteger(url.searchParams.get('limit'), 1, 200, 200)
    const offset = clampInteger(url.searchParams.get('offset'), 0, 10_000, 0)
    const placeholders = statuses.map(() => '?').join(',')
    const total = this.firstRow(
      `SELECT COUNT(*) AS count FROM jobs WHERE status IN (${placeholders})`,
      ...statuses
    ).count
    const rows = this.rows(
      `SELECT * FROM jobs WHERE status IN (${placeholders}) ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ...statuses,
      limit,
      offset
    )
    return json({
      jobs: rows.map(jobListItem),
      pagination: { offset, limit, total, has_more: offset + rows.length < total }
    })
  }

  jobDetail(id) {
    const row = this.firstRow('SELECT * FROM jobs WHERE id = ?', id)
    if (!row) return json({ error: 'Job not found' }, 404)
    return json({
      ...jobListItem(row),
      workflow: {
        prompt: JSON.parse(row.prompt),
        extra_data: JSON.parse(row.extra_data)
      },
      outputs: row.output_filename ? { [row.node_id]: imageOutput(row.output_filename) } : {},
      update_time: row.ended_at || row.started_at || row.created_at,
      execution_status: legacyStatus(row),
      execution_meta: {}
    })
  }

  legacyHistory(url) {
    const limit = clampInteger(url.searchParams.get('max_items'), 1, 200, 100)
    const rows = this.rows(
      "SELECT * FROM jobs WHERE status IN ('completed', 'failed', 'cancelled') ORDER BY created_at DESC LIMIT ?",
      limit
    )
    return json(Object.fromEntries(rows.map((row) => [row.id, legacyHistoryEntry(row)])))
  }

  legacyHistoryDetail(id) {
    const row = this.firstRow('SELECT * FROM jobs WHERE id = ?', id)
    if (!row) return json({})
    return json({ [id]: legacyHistoryEntry(row) })
  }

  async manageHistory(request) {
    const body = await request.json().catch(() => ({}))
    if (body.clear === true) {
      const objects = this.rows('SELECT output_key FROM jobs WHERE output_key IS NOT NULL')
      await Promise.all(objects.map((row) => this.env.IMAGES.delete(row.output_key)))
      this.sql.exec("DELETE FROM jobs WHERE status IN ('completed', 'failed', 'cancelled')")
    }
    if (Array.isArray(body.delete)) {
      for (const id of body.delete) {
        if (typeof id !== 'string') continue
        const row = this.firstRow('SELECT output_key FROM jobs WHERE id = ?', id)
        if (row?.output_key) await this.env.IMAGES.delete(row.output_key)
        this.sql.exec("DELETE FROM jobs WHERE id = ? AND status NOT IN ('pending', 'in_progress')", id)
      }
    }
    return json({})
  }

  async viewImage(url) {
    const filename = url.searchParams.get('filename')
    if (!filename) return json({ error: 'filename is required' }, 400)
    const row = this.firstRow(
      'SELECT output_key, media_type FROM jobs WHERE output_filename = ? AND output_key IS NOT NULL',
      filename
    )
    if (!row) return json({ error: 'Image not found' }, 404)
    const object = await this.env.IMAGES.get(row.output_key)
    if (!object) return json({ error: 'Image not found' }, 404)

    const headers = new Headers()
    object.writeHttpMetadata(headers)
    headers.set('Content-Type', row.media_type || 'application/octet-stream')
    headers.set('Cache-Control', 'private, max-age=31536000, immutable')
    headers.set('ETag', object.httpEtag)
    return new Response(object.body, { headers })
  }

  async settings(request) {
    if (request.method === 'GET') {
      const row = this.firstRow("SELECT value FROM metadata WHERE key = 'settings'")
      return json(row ? JSON.parse(row.value) : {})
    }
    if (request.method === 'POST') {
      const value = await request.json().catch(() => ({}))
      this.sql.exec(
        "INSERT INTO metadata(key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        JSON.stringify(value)
      )
      return json({})
    }
    return json({ error: 'Method not allowed' }, 405)
  }

  async generateImage(promptId, inputs) {
    if (!this.env.CHICKENDOG_API_KEY) throw new Error('CHICKENDOG_API_KEY is not configured')

    const base = (this.env.CHICKENDOG_API_BASE || 'https://chickendog.cc/v1').replace(/\/$/u, '')
    const response = await fetch(`${base}/images/generations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.env.CHICKENDOG_API_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': promptId
      },
      body: JSON.stringify({
        model: this.env.IMAGE_MODEL || 'gpt-image-2',
        prompt: inputs.prompt,
        size: inputs.size,
        quality: inputs.quality,
        output_format: inputs.output_format,
        response_format: 'b64_json',
        n: 1
      }),
      signal: AbortSignal.timeout(300_000)
    })

    const responseText = await response.text()
    let payload
    try {
      payload = JSON.parse(responseText)
    } catch {
      payload = undefined
    }

    if (!response.ok) {
      throw new Error(payload?.error?.message || payload?.message || `ChickenDog API failed (${response.status})`)
    }

    const image = extractProviderImage(payload)
    if (!image) throw new Error('ChickenDog API completed without returning an image')

    let bytes
    if (image.kind === 'base64') {
      bytes = Uint8Array.from(atob(image.value), (character) => character.charCodeAt(0))
    } else {
      const imageUrl = new URL(image.value)
      if (imageUrl.protocol !== 'https:') throw new Error('Provider returned an unsafe image URL')
      const imageResponse = await fetch(imageUrl)
      if (!imageResponse.ok) throw new Error(`Could not download provider image (${imageResponse.status})`)
      bytes = new Uint8Array(await imageResponse.arrayBuffer())
    }

    if (bytes.byteLength > 30 * 1024 * 1024) {
      throw new Error('Provider image exceeds the 30 MB storage limit')
    }

    const format = inputs.output_format
    const mediaType = imageMediaType(format)
    const filename = `gpt-image-${promptId}.${format}`
    const key = `sessions/${this.sessionId()}/output/${filename}`
    await this.env.IMAGES.put(key, bytes, {
      httpMetadata: { contentType: mediaType },
      customMetadata: { promptId, model: this.env.IMAGE_MODEL || 'gpt-image-2' }
    })
    return { key, filename, mediaType }
  }

  async trimHistory() {
    const maxHistory = clampInteger(this.env.MAX_HISTORY, 1, 1000, 100)
    const expired = this.rows(
      `SELECT id, output_key FROM jobs
       WHERE status IN ('completed', 'failed', 'cancelled')
       ORDER BY created_at DESC LIMIT -1 OFFSET ?`,
      maxHistory
    )
    for (const row of expired) {
      if (row.output_key) await this.env.IMAGES.delete(row.output_key)
      this.sql.exec('DELETE FROM jobs WHERE id = ?', row.id)
    }
  }

  pendingCount() {
    return this.firstRow("SELECT COUNT(*) AS count FROM jobs WHERE status = 'pending'").count
  }

  sessionId() {
    return this.firstRow("SELECT value FROM metadata WHERE key = 'session_id'")?.value || 'unknown'
  }

  broadcastStatus() {
    this.broadcast({
      type: 'status',
      data: {
        status: { exec_info: { queue_remaining: this.pendingCount() } },
        sid: this.sessionId()
      }
    })
  }

  broadcast(message) {
    const encoded = JSON.stringify(message)
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(encoded)
      } catch {
        // Hibernated sockets can disappear between enumeration and send.
      }
    }
  }

  rows(query, ...params) {
    return this.sql.exec(query, ...params).toArray()
  }

  firstRow(query, ...params) {
    return this.rows(query, ...params)[0]
  }
}

function sessionFromRequest(request, url) {
  const clientId = url.searchParams.get('clientId')
  if (isSessionId(clientId)) return clientId
  const cookie = parseSessionCookie(request.headers.get('Cookie'))
  return isSessionId(cookie) ? cookie : undefined
}

function originAllowed(request, allowedOrigin) {
  if (!allowedOrigin) return true
  const origin = request.headers.get('Origin')
  return !origin || origin === allowedOrigin
}

function staticApiResponse(url, method) {
  if (method !== 'GET') return json({ error: 'Method not allowed' }, 405)
  if (url.pathname === '/api/extensions') return json(['/extensions/cloudflare/gpt-image.js'])
  if (url.pathname === '/api/workflow_templates') return json({})
  if (url.pathname === '/api/embeddings') return json([])
  if (url.pathname === '/api/features') {
    return json({ supports_preview_metadata: false, max_upload_size: 0 })
  }
  if (url.pathname === '/api/node_replacements' || url.pathname === '/api/global_subgraphs') {
    return json({})
  }
  if (url.pathname === '/api/system_stats') {
    return json({
      system: {
        os: 'cloudflare-workers',
        comfyui_version: 'cloudflare-adapter-1',
        python_version: 'not installed',
        embedded_python: false
      },
      devices: []
    })
  }
  if (url.pathname === '/api/userdata/user.css') {
    return new Response('', { headers: { 'Content-Type': 'text/css; charset=utf-8' } })
  }
  if (url.pathname === '/api/userdata' || url.pathname.startsWith('/api/userdata/')) {
    return json([], url.pathname === '/api/userdata' ? 200 : 404)
  }
  return json({ error: 'Not found' }, 404)
}

function serverFeatureFlags() {
  return {
    supports_progress_text_metadata: false,
    supports_preview_metadata: false,
    supports_jobs_api: true
  }
}

function imageOutput(filename) {
  return { images: [{ filename, subfolder: '', type: 'output' }] }
}

function legacyQueueItem(row) {
  return [
    row.created_at,
    row.id,
    JSON.parse(row.prompt),
    JSON.parse(row.extra_data),
    [row.node_id]
  ]
}

function legacyHistoryEntry(row) {
  return {
    prompt: legacyQueueItem(row),
    outputs: row.output_filename ? { [row.node_id]: imageOutput(row.output_filename) } : {},
    status: legacyStatus(row),
    meta: {}
  }
}

function legacyStatus(row) {
  const completed = row.status === 'completed'
  return {
    status_str: completed ? 'success' : row.status,
    completed,
    messages: row.error ? [['execution_error', { exception_message: row.error }]] : []
  }
}

function jobListItem(row) {
  const status = row.status === 'failed' ? 'failed' : row.status
  return {
    id: row.id,
    status,
    create_time: row.created_at,
    execution_start_time: row.started_at ?? null,
    execution_end_time: row.ended_at ?? null,
    preview_output: row.output_filename
      ? {
          filename: row.output_filename,
          subfolder: '',
          type: 'output',
          nodeId: row.node_id,
          mediaType: row.media_type || 'image/png'
        }
      : null,
    outputs_count: row.output_filename ? 1 : 0,
    execution_error: row.error
      ? {
          prompt_id: row.id,
          timestamp: row.ended_at || Date.now(),
          node_id: row.node_id,
          node_type: NODE_CLASS,
          executed: [],
          exception_message: row.error,
          exception_type: 'ProviderError',
          traceback: [],
          current_inputs: {},
          current_outputs: {}
        }
      : null,
    workflow_id: null
  }
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'Unknown error')
}

function json(value, status = 200) {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store' }
  })
}
