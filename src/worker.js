import { DurableObject } from 'cloudflare:workers'
import {
  SESSION_TTL_SECONDS,
  assertSessionSecret,
  consumeLoginTicket,
  createLoginTicket,
  expiredSessionCookie,
  sessionCookie
} from './auth.js'
import {
  MAX_USER_ASSETS,
  MAX_USER_ASSET_BYTES,
  MAX_UPLOAD_BYTES,
  TEMP_IMAGE_RETENTION_DAYS,
  imageStreamPayload,
  inspectImage,
  uploadFilename
} from './images.js'
import {
  NODE_CLASS,
  NODE_DEFINITIONS,
  executeWorkflow,
  extractProviderImages,
  imageMediaType,
  isSessionId,
  parsePromptRequest,
  parseSessionCookie
} from './protocol.js'
import { UpstreamError, configuredGroupId, provisionManagedUser } from './sub2api.js'
import {
  MAX_USER_DATA_BYTES,
  decodeUserDataPath,
  relativeUserDataPath,
  userStorageNamespace,
  validateUserDataDirectory
} from './userdata.js'

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (url.pathname === '/api/health') {
      return json({
        ok: true,
        provider: env.CHICKENDOG_API_BASE || 'https://chickendog.cc/v1',
        model: env.IMAGE_MODEL || 'gpt-image-2',
        groupId: configuredGroupId(env),
        configured: sessionSecretConfigured(env.COMFY_SESSION_SECRET),
        nodes: Object.keys(NODE_DEFINITIONS),
        maxUploadBytes: MAX_UPLOAD_BYTES,
        maxUserAssets: MAX_USER_ASSETS,
        maxUserAssetBytes: MAX_USER_ASSET_BYTES,
        temporaryImageRetentionDays: TEMP_IMAGE_RETENTION_DAYS,
        imageStreaming: true
      })
    }

    if (url.pathname === '/api/sso/start') return startSSO(request, env)
    if (url.pathname === '/api/auth/callback') return finishSSO(request, env, url)
    if (url.pathname === '/api/logout') return logout(request, env)

    if (url.pathname !== '/ws' && !url.pathname.startsWith('/api/')) {
      return json({ error: 'Not found' }, 404)
    }

    if (!originAllowed(request, env.ALLOWED_ORIGIN)) {
      return json({ error: 'Origin not allowed' }, 403)
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204 })
    }

    const sessionId = sessionFromRequest(request)
    if (!sessionId) return authRequired()

    const id = env.COMFY_SESSIONS.idFromName(sessionId)
    const stub = env.COMFY_SESSIONS.get(id)
    const headers = new Headers(request.headers)
    headers.set('X-Comfy-Session', sessionId)
    return stub.fetch(new Request(request, { headers }))
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
      CREATE TABLE IF NOT EXISTS job_artifacts (
        job_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        output_key TEXT NOT NULL,
        output_filename TEXT NOT NULL,
        media_type TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        output_type TEXT NOT NULL,
        owns_object INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(job_id, node_id, output_filename)
      );
      CREATE INDEX IF NOT EXISTS job_artifacts_filename_idx ON job_artifacts(output_filename);
      CREATE INDEX IF NOT EXISTS job_artifacts_job_idx ON job_artifacts(job_id);
      CREATE TABLE IF NOT EXISTS uploads (
        filename TEXT PRIMARY KEY,
        output_key TEXT NOT NULL,
        media_type TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        has_alpha INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS uploads_created_idx ON uploads(created_at);
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
    const artifactColumns = this.sql.exec('PRAGMA table_info(job_artifacts)').toArray()
    if (!artifactColumns.some((column) => column.name === 'owns_object')) {
      this.sql.exec('ALTER TABLE job_artifacts ADD COLUMN owns_object INTEGER NOT NULL DEFAULT 1')
    }
    this.sql.exec("UPDATE jobs SET status = 'pending', started_at = NULL WHERE status = 'in_progress'")
  }

  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/__bootstrap' && request.method === 'POST') return this.bootstrap(request)
    if (url.pathname === '/__logout' && request.method === 'POST') return this.logout()

    const sessionId = request.headers.get('X-Comfy-Session')
    if (isSessionId(sessionId)) {
      this.sql.exec(
        'INSERT INTO metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        'session_id',
        sessionId
      )
    }

    const user = this.authenticatedUser()
    if (!user) return authRequired()

    try {
      if (url.pathname === '/api/session' && request.method === 'GET') {
        return json({ user: publicUser(user) })
      }
      if (url.pathname === '/ws') return this.openWebSocket(request)
      if (url.pathname === '/api/object_info' && request.method === 'GET') return json(await this.objectInfo())
      if (url.pathname.startsWith('/api/object_info/') && request.method === 'GET') {
        const nodeClass = decodeURIComponent(url.pathname.slice('/api/object_info/'.length))
        const definition = (await this.objectInfo())[nodeClass]
        return definition ? json(definition) : json({}, 404)
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
      if (url.pathname === '/api/upload/image' && request.method === 'POST') return this.uploadImage(request)
      if (url.pathname === '/api/view' && request.method === 'GET') return this.viewImage(url)
      if (url.pathname === '/api/userdata' || url.pathname.startsWith('/api/userdata/')) {
        return this.userData(request, url)
      }
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
    this.broadcastStatus()

    const executionState = {
      artifacts: [],
      currentNode: undefined,
      executed: [],
      generatedKeys: new Set(),
      publishedKeys: new Set()
    }
    try {
      const graph = JSON.parse(job.prompt)
      const parsed = parsePromptRequest({ prompt: graph, extra_data: JSON.parse(job.extra_data) })
      if (!parsed.ok) throw new Error(parsed.body.error.message)

      await executeWorkflow(parsed.value, {
        generateImage: (inputs, nodeId) => this.generateImage(job.id, nodeId, inputs, executionState),
        editImage: (inputs, nodeId) => this.editImage(job.id, nodeId, inputs, executionState),
        loadImage: (filename, type) => this.loadImage(filename, type),
        publishImage: (image, nodeId, outputType, prefix) =>
          this.publishImage(job.id, nodeId, image, outputType, prefix, executionState),
        nodeStarted: (node) => {
          executionState.currentNode = node
          this.broadcast({ type: 'executing', data: { node: node.id, prompt_id: job.id } })
        },
        nodeCompleted: (node) => {
          executionState.executed.push(node.id)
        }
      })

      await this.removeUnpublishedImages(executionState)
      const output =
        executionState.artifacts.find((artifact) => artifact.outputType === 'output') ||
        executionState.artifacts[0]
      if (!output) throw new Error('Workflow completed without publishing an image')
      const endedAt = Date.now()
      this.sql.exec(
        `UPDATE jobs
         SET status = 'completed', ended_at = ?, output_key = ?, output_filename = ?, media_type = ?
         WHERE id = ?`,
        endedAt,
        output.key,
        output.filename,
        output.contentType,
        job.id
      )

      this.broadcast({ type: 'execution_success', data: { prompt_id: job.id, timestamp: endedAt } })
    } catch (error) {
      await this.removeExecutionImages(job.id, executionState)
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
          node_id: executionState.currentNode?.id || job.node_id,
          node_type: executionState.currentNode?.class_type || NODE_CLASS,
          executed: executionState.executed,
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
    this.sql.exec(
      `INSERT INTO jobs(id, status, created_at, node_id, prompt, extra_data)
       VALUES (?, 'pending', ?, ?, ?, ?)`,
      promptId,
      createdAt,
      value.nodeId,
      JSON.stringify(value.graph),
      JSON.stringify(value.extraData)
    )

    await this.ctx.storage.setAlarm(Date.now() + 50)
    this.broadcast({ type: 'promptQueued', data: { prompt_id: promptId } })
    this.broadcastStatus()
    return json({ prompt_id: promptId, number: createdAt, node_errors: {} })
  }

  async objectInfo() {
    await this.migrateSessionAssets()
    const definitions = structuredClone(NODE_DEFINITIONS)
    const uploads = this.rows('SELECT filename FROM uploads ORDER BY created_at DESC').map((row) => row.filename)
    const masks = this.rows(
      'SELECT filename FROM uploads WHERE has_alpha = 1 ORDER BY created_at DESC'
    ).map((row) => row.filename)
    const history = this.rows(
      'SELECT output_filename AS filename FROM job_artifacts ORDER BY created_at DESC LIMIT 200'
    ).map((row) => row.filename)
    const assets = await this.listUserAssets()
    const persistentUploads = assets.filter((asset) => asset.kind === 'upload')
    definitions.LoadImage.input.required.image[0] = [
      ...new Set([...persistentUploads.map((asset) => asset.filename), ...assets.map((asset) => asset.filename), ...uploads, ...history])
    ]
    definitions.MaskImage.input.required.image[0] = [
      ...new Set([...persistentUploads.filter((asset) => asset.hasAlpha).map((asset) => asset.filename), ...masks])
    ]
    return definitions
  }

  async migrateSessionAssets() {
    const sessionPrefix = `sessions/${this.sessionId()}/`
    const persistentPrefix = await this.userAssetPrefix()
    const temporaryPrefix = await this.userTemporaryPrefix()
    const oldKeys = new Set()

    for (const upload of this.rows('SELECT * FROM uploads')) {
      if (!upload.output_key.startsWith(sessionPrefix)) continue
      const source = await this.env.IMAGES.get(upload.output_key)
      if (!source) continue
      const destinationKey = `${persistentPrefix}uploads/${upload.filename}`
      await this.env.IMAGES.put(destinationKey, await source.arrayBuffer(), {
        httpMetadata: { contentType: upload.media_type },
        customMetadata: {
          kind: 'upload',
          filename: upload.filename,
          width: String(upload.width),
          height: String(upload.height),
          hasAlpha: String(upload.has_alpha === 1),
          createdAt: String(upload.created_at)
        }
      })
      this.sql.exec('UPDATE uploads SET output_key = ? WHERE filename = ?', destinationKey, upload.filename)
      oldKeys.add(upload.output_key)
    }

    const artifacts = this.rows(
      `SELECT job_id, node_id, output_key, output_filename, media_type, width, height, output_type, created_at
       FROM job_artifacts WHERE output_key LIKE ?`,
      `${sessionPrefix}%`
    )
    for (const artifact of artifacts) {
      const source = await this.env.IMAGES.get(artifact.output_key)
      if (!source) continue
      const destinationKey = artifact.output_type === 'output'
        ? `${persistentPrefix}saved/${artifact.output_filename}`
        : `${temporaryPrefix}${artifact.output_filename}`
      await this.env.IMAGES.put(destinationKey, await source.arrayBuffer(), {
        httpMetadata: { contentType: artifact.media_type },
        customMetadata: {
          kind: artifact.output_type === 'output' ? 'saved' : 'temporary',
          filename: artifact.output_filename,
          width: String(artifact.width),
          height: String(artifact.height),
          hasAlpha: 'false',
          promptId: artifact.job_id,
          nodeId: artifact.node_id,
          source: artifact.output_key,
          createdAt: String(artifact.created_at)
        }
      })
      this.sql.exec(
        'UPDATE job_artifacts SET output_key = ?, owns_object = 0 WHERE job_id = ? AND node_id = ? AND output_filename = ?',
        destinationKey,
        artifact.job_id,
        artifact.node_id,
        artifact.output_filename
      )
      this.sql.exec(
        'UPDATE jobs SET output_key = ? WHERE id = ? AND output_key = ?',
        destinationKey,
        artifact.job_id,
        artifact.output_key
      )
      oldKeys.add(artifact.output_key)
    }

    await Promise.allSettled([...oldKeys].map((key) => this.env.IMAGES.delete(key)))
  }

  async uploadImage(request) {
    const length = Number(request.headers.get('Content-Length') || 0)
    if (length > MAX_UPLOAD_BYTES + 1024 * 1024) {
      return json({ error: 'Image upload exceeds the 20 MiB limit' }, 413)
    }

    const form = await request.formData().catch(() => undefined)
    const image = form?.get('image')
    if (!(image instanceof File)) return json({ error: 'A multipart image file is required' }, 400)
    if (form.get('type') && form.get('type') !== 'input') {
      return json({ error: 'Only input image uploads are supported' }, 400)
    }
    let bytes
    let metadata
    try {
      bytes = new Uint8Array(await image.arrayBuffer())
      metadata = inspectImage(bytes, image.type)
    } catch (error) {
      return json({ error: errorMessage(error) }, 400)
    }

    const uploadId = crypto.randomUUID()
    const filename = uploadFilename(image.name, metadata.extension, uploadId)
    await this.assertPersistentAssetCapacity(bytes.byteLength)
    const key = `${await this.userAssetPrefix()}uploads/${filename}`
    await this.env.IMAGES.put(key, bytes, {
      httpMetadata: { contentType: metadata.contentType },
      customMetadata: {
        kind: 'upload',
        filename,
        width: String(metadata.width),
        height: String(metadata.height),
        hasAlpha: String(metadata.hasAlpha),
        createdAt: String(Date.now())
      }
    })
    this.sql.exec(
      `INSERT INTO uploads(filename, output_key, media_type, width, height, has_alpha, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      filename,
      key,
      metadata.contentType,
      metadata.width,
      metadata.height,
      metadata.hasAlpha ? 1 : 0,
      Date.now()
    )
    return json({ name: filename, subfolder: '', type: 'input' })
  }

  async loadImage(filename, type) {
    const upload = this.firstRow('SELECT * FROM uploads WHERE filename = ?', filename)
    const history = type === 'IMAGE' && !upload
      ? this.firstRow(
          `SELECT output_filename AS filename, output_key, media_type, width, height
           FROM job_artifacts WHERE output_filename = ? ORDER BY created_at DESC LIMIT 1`,
          filename
        )
      : undefined
    const asset = !upload && !history ? await this.findUserAsset(filename, type) : undefined
    const source = upload || history || asset
    if (!source) throw new Error(`Image ${filename} was not found in your workspace`)
    const hasAlpha = upload ? upload.has_alpha === 1 : asset?.hasAlpha === true
    if (type === 'MASK' && !hasAlpha) {
      throw new Error('Mask images must contain an alpha channel')
    }
    const key = source.output_key || source.key
    const object = await this.env.IMAGES.head(key)
    if (!object) throw new Error(`Uploaded image ${filename} is no longer available`)
    return {
      type,
      key,
      filename: source.filename,
      contentType: source.media_type || source.contentType,
      width: source.width,
      height: source.height,
      hasAlpha
    }
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
    const artifactOutputs = this.artifactOutputs(row.id)
    return json({
      ...jobListItem(row),
      workflow: {
        prompt: JSON.parse(row.prompt),
        extra_data: JSON.parse(row.extra_data)
      },
      outputs: Object.keys(artifactOutputs).length
        ? artifactOutputs
        : row.output_filename
          ? { [row.node_id]: imageOutput(row.output_filename) }
          : {},
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
    return json(Object.fromEntries(rows.map((row) => [row.id, legacyHistoryEntry(row, this.artifactOutputs(row.id))])))
  }

  legacyHistoryDetail(id) {
    const row = this.firstRow('SELECT * FROM jobs WHERE id = ?', id)
    if (!row) return json({})
    return json({ [id]: legacyHistoryEntry(row, this.artifactOutputs(row.id)) })
  }

  async manageHistory(request) {
    const body = await request.json().catch(() => ({}))
    if (body.clear === true) {
      const objects = this.rows(
        `SELECT DISTINCT artifact.output_key
         FROM job_artifacts artifact
         JOIN jobs job ON job.id = artifact.job_id
         WHERE job.status IN ('completed', 'failed', 'cancelled') AND artifact.owns_object = 1
         UNION
         SELECT job.output_key
         FROM jobs job
         WHERE job.status IN ('completed', 'failed', 'cancelled')
           AND job.output_key IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM job_artifacts artifact WHERE artifact.job_id = job.id)`
      )
      await Promise.all(objects.map((row) => this.env.IMAGES.delete(row.output_key)))
      this.sql.exec(
        `DELETE FROM job_artifacts
         WHERE job_id IN (SELECT id FROM jobs WHERE status IN ('completed', 'failed', 'cancelled'))`
      )
      this.sql.exec("DELETE FROM jobs WHERE status IN ('completed', 'failed', 'cancelled')")
    }
    if (Array.isArray(body.delete)) {
      for (const id of body.delete) {
        if (typeof id !== 'string') continue
        const job = this.firstRow('SELECT status FROM jobs WHERE id = ?', id)
        if (!job || job.status === 'pending' || job.status === 'in_progress') continue
        const objects = this.rows(
          `SELECT DISTINCT output_key FROM job_artifacts WHERE job_id = ? AND owns_object = 1
           UNION
           SELECT output_key FROM jobs
           WHERE id = ? AND output_key IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM job_artifacts WHERE job_id = ?)`,
          id,
          id,
          id
        )
        await Promise.all(objects.map((row) => this.env.IMAGES.delete(row.output_key)))
        this.sql.exec('DELETE FROM job_artifacts WHERE job_id = ?', id)
        this.sql.exec("DELETE FROM jobs WHERE id = ? AND status NOT IN ('pending', 'in_progress')", id)
      }
    }
    return json({})
  }

  async viewImage(url) {
    const filename = url.searchParams.get('filename')
    if (!filename) return json({ error: 'filename is required' }, 400)
    const local = url.searchParams.get('type') === 'input'
      ? this.firstRow('SELECT output_key, media_type FROM uploads WHERE filename = ?', filename) ||
        this.firstRow(
          'SELECT output_key, media_type FROM job_artifacts WHERE output_filename = ? ORDER BY created_at DESC LIMIT 1',
          filename
        )
      : this.firstRow(
          'SELECT output_key, media_type FROM job_artifacts WHERE output_filename = ? ORDER BY created_at DESC LIMIT 1',
          filename
        ) ||
        this.firstRow(
          'SELECT output_key, media_type FROM jobs WHERE output_filename = ? AND output_key IS NOT NULL',
          filename
        )
    const asset = local ? undefined : await this.findUserAsset(filename, 'IMAGE')
    const source = local || asset
    if (!source) return json({ error: 'Image not found' }, 404)
    const object = await this.env.IMAGES.get(source.output_key || source.key)
    if (!object) return json({ error: 'Image not found' }, 404)

    const headers = new Headers()
    object.writeHttpMetadata(headers)
    headers.set('Content-Type', source.media_type || source.contentType || 'application/octet-stream')
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

  async userData(request, url) {
    if (url.pathname === '/api/userdata') {
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405)
      return this.listUserData(url)
    }

    const encodedRoute = url.pathname.slice('/api/userdata/'.length)
    const moveSeparator = '/move/'
    const moveIndex = encodedRoute.indexOf(moveSeparator)
    if (moveIndex !== -1) {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
      let source
      let destination
      try {
        source = decodeUserDataPath(encodedRoute.slice(0, moveIndex))
        destination = decodeUserDataPath(encodedRoute.slice(moveIndex + moveSeparator.length))
      } catch (error) {
        return json({ error: errorMessage(error) }, 400)
      }
      return this.moveUserData(source, destination, url.searchParams.get('overwrite') === 'true')
    }

    let path
    try {
      path = decodeUserDataPath(encodedRoute)
    } catch (error) {
      return json({ error: errorMessage(error) }, 400)
    }

    if (request.method === 'GET') return this.getUserData(path, url)
    if (request.method === 'POST') return this.storeUserData(path, request, url)
    if (request.method === 'DELETE') return this.deleteUserData(path)
    return json({ error: 'Method not allowed' }, 405)
  }

  async listUserData(url) {
    let directory
    try {
      directory = validateUserDataDirectory(url.searchParams.get('dir') || '')
    } catch (error) {
      return json({ error: errorMessage(error) }, 400)
    }
    const recurse = url.searchParams.get('recurse') !== 'false'
    const fullInfo = url.searchParams.get('full_info') === 'true'
    const prefix = await this.userDataPrefix()
    const objects = []
    let cursor
    do {
      const page = await this.env.IMAGES.list({ prefix, cursor })
      objects.push(...page.objects)
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
    const entries = objects.flatMap((object) => {
      const path = relativeUserDataPath(object.key.slice(prefix.length), directory, recurse)
      if (!path) return []
      return [fullInfo ? { path, size: object.size, modified: object.uploaded.getTime() } : path]
    })
    entries.sort((left, right) => {
      const leftPath = typeof left === 'string' ? left : left.path
      const rightPath = typeof right === 'string' ? right : right.path
      return leftPath.localeCompare(rightPath)
    })
    return json(entries)
  }

  async getUserData(path, url) {
    const object = await this.env.IMAGES.get(`${await this.userDataPrefix()}${path}`)
    if (!object) {
      if (path === 'user.css') {
        return new Response('', { headers: { 'Content-Type': 'text/css; charset=utf-8' } })
      }
      return json({ error: 'User data file not found' }, 404)
    }
    if (url.searchParams.get('full_info') === 'true') {
      return json({ path, size: object.size, modified: object.uploaded.getTime() })
    }
    const headers = new Headers()
    object.writeHttpMetadata(headers)
    headers.set('Cache-Control', 'no-store')
    headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream')
    return new Response(object.body, {
      headers: {
        ...Object.fromEntries(headers)
      }
    })
  }

  async storeUserData(path, request, url) {
    const length = Number(request.headers.get('Content-Length') || 0)
    if (length > MAX_USER_DATA_BYTES) return json({ error: 'User data file is too large' }, 413)

    const content = await request.text()
    const size = new TextEncoder().encode(content).byteLength
    if (size > MAX_USER_DATA_BYTES) return json({ error: 'User data file is too large' }, 413)

    const overwrite = url.searchParams.get('overwrite') === 'true'
    const key = `${await this.userDataPrefix()}${path}`
    if (!overwrite && await this.env.IMAGES.head(key)) {
      return json({ error: 'User data file already exists' }, 409)
    }
    const contentType = normalizedUserDataContentType(request.headers.get('Content-Type'))
    const updatedAt = Date.now()
    await this.env.IMAGES.put(key, content, {
      httpMetadata: { contentType },
      customMetadata: { path, updatedAt: String(updatedAt) }
    })
    if (url.searchParams.get('full_info') === 'true') {
      return json({ path, size, modified: updatedAt })
    }
    return json({})
  }

  async deleteUserData(path) {
    const key = `${await this.userDataPrefix()}${path}`
    if (!await this.env.IMAGES.head(key)) return json({ error: 'User data file not found' }, 404)
    await this.env.IMAGES.delete(key)
    return json({})
  }

  async moveUserData(source, destination, overwrite) {
    const prefix = await this.userDataPrefix()
    const sourceKey = `${prefix}${source}`
    const destinationKey = `${prefix}${destination}`
    const object = await this.env.IMAGES.get(sourceKey)
    if (!object) return json({ error: 'User data file not found' }, 404)
    if (source === destination) return json({})
    if (!overwrite && await this.env.IMAGES.head(destinationKey)) {
      return json({ error: 'Destination user data file already exists' }, 409)
    }
    const contentType = object.httpMetadata?.contentType || 'application/octet-stream'
    await this.env.IMAGES.put(destinationKey, await object.arrayBuffer(), {
      httpMetadata: { contentType },
      customMetadata: { path: destination, updatedAt: String(Date.now()) }
    })
    await this.env.IMAGES.delete(sourceKey)
    return json({})
  }

  async userDataPrefix() {
    return `users/${await this.userNamespace()}/userdata/`
  }

  async userAssetPrefix() {
    return `users/${await this.userNamespace()}/assets/`
  }

  async userTemporaryPrefix() {
    return `temporary/${await this.userNamespace()}/`
  }

  async userNamespace() {
    if (this.userNamespaceValue) return this.userNamespaceValue
    const user = this.authenticatedUser()
    if (!user) throw new Error('Your ChickenDog session has expired')
    this.userNamespaceValue = await userStorageNamespace(user.userId)
    return this.userNamespaceValue
  }

  async listUserAssets() {
    const persistentPrefix = await this.userAssetPrefix()
    const temporaryPrefix = await this.userTemporaryPrefix()
    const groups = await Promise.all([
      this.listR2Objects(`${persistentPrefix}uploads/`),
      this.listR2Objects(`${persistentPrefix}saved/`),
      this.listR2Objects(temporaryPrefix)
    ])
    const assets = [
      ...groups[0].map((object) => r2Asset(object, 'upload')),
      ...groups[1].map((object) => r2Asset(object, 'saved')),
      ...groups[2].map((object) => r2Asset(object, 'temporary'))
    ].filter((asset) => asset.filename)
    return assets.sort((left, right) => right.uploaded - left.uploaded)
  }

  async listR2Objects(prefix) {
    const objects = []
    let cursor
    do {
      const page = await this.env.IMAGES.list({
        prefix,
        cursor,
        include: ['httpMetadata', 'customMetadata']
      })
      objects.push(...page.objects)
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
    return objects
  }

  async findUserAsset(filename, type) {
    const persistentPrefix = await this.userAssetPrefix()
    const candidates = type === 'MASK'
      ? [{ key: `${persistentPrefix}uploads/${filename}`, kind: 'upload' }]
      : [
          { key: `${persistentPrefix}uploads/${filename}`, kind: 'upload' },
          { key: `${persistentPrefix}saved/${filename}`, kind: 'saved' },
          { key: `${await this.userTemporaryPrefix()}${filename}`, kind: 'temporary' }
        ]
    const objects = await Promise.all(candidates.map((candidate) => this.env.IMAGES.head(candidate.key)))
    const index = objects.findIndex(Boolean)
    return index === -1 ? undefined : r2Asset(objects[index], candidates[index].kind)
  }

  async assertPersistentAssetCapacity(additionalBytes) {
    const prefix = await this.userAssetPrefix()
    const objects = await this.listR2Objects(prefix)
    const totalBytes = objects.reduce((total, object) => total + object.size, 0)
    if (objects.length >= MAX_USER_ASSETS) {
      throw new Error(`Your workspace may contain at most ${MAX_USER_ASSETS} saved images`)
    }
    if (totalBytes + additionalBytes > MAX_USER_ASSET_BYTES) {
      throw new Error('Your saved image workspace has reached its 2 GiB limit')
    }
  }

  async generateImage(promptId, nodeId, inputs, executionState) {
    const user = this.authenticatedUser()
    if (!user) throw new Error('Your ChickenDog session has expired')

    const base = (this.env.CHICKENDOG_API_BASE || 'https://chickendog.cc/v1').replace(/\/$/u, '')
    const response = await fetch(`${base}/images/generations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${user.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `${promptId}-${nodeId}`
      },
      body: JSON.stringify({
        model: this.env.IMAGE_MODEL || 'gpt-image-2',
        prompt: inputs.prompt,
        size: inputs.size,
        quality: inputs.quality,
        output_format: inputs.output_format,
        n: inputs.batch_size,
        stream: true,
        partial_images: 1
      }),
      signal: AbortSignal.timeout(300_000)
    })

    const payload = await imageStreamPayload(response, 'image_generation.completed')
    return this.storeProviderImages(promptId, nodeId, inputs, payload, executionState)
  }

  async editImage(promptId, nodeId, inputs, executionState) {
    const user = this.authenticatedUser()
    if (!user) throw new Error('Your ChickenDog session has expired')

    const references = ['image_1', 'image_2', 'image_3', 'image_4']
      .flatMap((name) => imageItems(inputs[name]))
      .filter(Boolean)
    if (references.length === 0) throw new Error('At least one reference image is required')
    if (references.length > 4) throw new Error('Image edits support at most four reference images')
    for (const reference of references) await this.assertOwnedImage(reference, 'IMAGE')

    const mask = inputs.mask
    if (mask) {
      await this.assertOwnedImage(mask, 'MASK')
      const first = references[0]
      if (
        !mask.hasAlpha ||
        mask.contentType !== first.contentType ||
        mask.width !== first.width ||
        mask.height !== first.height
      ) {
        throw new Error('The mask must have alpha and match the first reference image format and dimensions')
      }
    }

    const form = new FormData()
    form.set('model', this.env.IMAGE_MODEL || 'gpt-image-2')
    form.set('prompt', inputs.prompt)
    form.set('size', inputs.size)
    form.set('quality', inputs.quality)
    form.set('output_format', inputs.output_format)
    form.set('n', String(inputs.batch_size))
    form.set('stream', 'true')
    form.set('partial_images', '1')

    let inputBytes = 0
    for (const [index, reference] of references.entries()) {
      const object = await this.env.IMAGES.get(reference.key)
      if (!object) throw new Error(`Reference image ${index + 1} is no longer available`)
      inputBytes += object.size
      if (inputBytes > 40 * 1024 * 1024) throw new Error('Edit inputs exceed the 40 MiB combined limit')
      form.append(
        'image[]',
        await object.blob(),
        reference.filename || `reference-${index + 1}.${imageExtension(reference.contentType)}`
      )
    }
    if (mask) {
      const object = await this.env.IMAGES.get(mask.key)
      if (!object) throw new Error('Mask image is no longer available')
      inputBytes += object.size
      if (inputBytes > 40 * 1024 * 1024) throw new Error('Edit inputs exceed the 40 MiB combined limit')
      form.append('mask', await object.blob(), mask.filename || `mask.${imageExtension(mask.contentType)}`)
    }

    const base = (this.env.CHICKENDOG_API_BASE || 'https://chickendog.cc/v1').replace(/\/$/u, '')
    const response = await fetch(`${base}/images/edits`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${user.apiKey}`,
        'Idempotency-Key': `${promptId}-${nodeId}`
      },
      body: form,
      signal: AbortSignal.timeout(300_000)
    })
    const payload = await imageStreamPayload(response, [
      'image_generation.completed',
      'image_edit.completed'
    ])
    return this.storeProviderImages(promptId, nodeId, inputs, payload, executionState)
  }

  async assertOwnedImage(image, type) {
    const allowedPrefixes = [
      `sessions/${this.sessionId()}/`,
      await this.userAssetPrefix(),
      await this.userTemporaryPrefix()
    ]
    if (
      !image ||
      image.type !== type ||
      typeof image.key !== 'string' ||
      !allowedPrefixes.some((prefix) => image.key.startsWith(prefix))
    ) {
      throw new Error(`Invalid ${type.toLowerCase()} reference`)
    }
  }

  async storeProviderImages(promptId, nodeId, inputs, payload, executionState) {
    const providerImages = extractProviderImages(payload)
    if (providerImages.length === 0) throw new Error('ChickenDog API completed without returning an image')

    const images = []
    for (const [index, image] of providerImages.entries()) {
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
      const filename = `${safePathPart(nodeId, 'image')}-${index + 1}.${format}`
      const key = `sessions/${this.sessionId()}/output/${promptId}/${filename}`
      await this.env.IMAGES.put(key, bytes, {
        httpMetadata: { contentType: mediaType },
        customMetadata: {
          promptId,
          nodeId,
          batchIndex: String(index),
          model: this.env.IMAGE_MODEL || 'gpt-image-2'
        }
      })
      executionState.generatedKeys.add(key)
      const [width, height] = inputs.size.split('x').map(Number)
      images.push({ type: 'IMAGE', key, contentType: mediaType, width, height })
    }
    return images.length === 1 ? images[0] : { type: 'IMAGE', images }
  }

  async publishImage(promptId, nodeId, image, outputType, prefix, executionState) {
    const images = imageItems(image)
    const artifacts = []
    for (const [index, item] of images.entries()) {
      artifacts.push(
        await this.publishSingleImage(promptId, nodeId, item, outputType, prefix, executionState, index, images.length)
      )
    }
    this.broadcast({
      type: 'executed',
      data: {
        node: nodeId,
        display_node: nodeId,
        output: imageOutput(artifacts),
        prompt_id: promptId
      }
    })
  }

  async publishSingleImage(promptId, nodeId, image, outputType, prefix, executionState, index, total) {
    try {
      await this.assertOwnedImage(image, 'IMAGE')
    } catch {
      throw new Error(`Node ${nodeId} received an invalid image reference`)
    }

    const extension = imageExtension(image.contentType)
    const defaultPrefix = outputType === 'temp' ? 'preview' : 'ComfyUI'
    const suffix = total > 1 ? `_${index + 1}` : ''
    const filename = `${safePathPart(prefix, defaultPrefix)}_${promptId.slice(0, 8)}_${safePathPart(nodeId, 'node')}${suffix}.${extension}`
    const source = await this.env.IMAGES.get(image.key)
    if (!source) throw new Error('The image to publish is no longer available')
    if (outputType === 'output') await this.assertPersistentAssetCapacity(source.size)
    const destinationKey = outputType === 'output'
      ? `${await this.userAssetPrefix()}saved/${filename}`
      : `${await this.userTemporaryPrefix()}${filename}`
    await this.env.IMAGES.put(destinationKey, await source.arrayBuffer(), {
      httpMetadata: { contentType: image.contentType },
      customMetadata: {
        kind: outputType === 'output' ? 'saved' : 'temporary',
        filename,
        width: String(image.width),
        height: String(image.height),
        hasAlpha: 'false',
        promptId,
        nodeId,
        source: image.key,
        createdAt: String(Date.now())
      }
    })
    executionState.generatedKeys.add(destinationKey)
    executionState.publishedKeys.add(destinationKey)
    const publishedImage = { ...image, key: destinationKey, filename }
    const artifact = {
      ...publishedImage,
      filename,
      nodeId,
      outputType
    }
    this.sql.exec(
      `INSERT OR REPLACE INTO job_artifacts(
         job_id, node_id, output_key, output_filename, media_type, width, height, output_type, owns_object, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      promptId,
      nodeId,
      publishedImage.key,
      filename,
      publishedImage.contentType,
      publishedImage.width,
      publishedImage.height,
      outputType,
      0,
      Date.now()
    )
    executionState.artifacts.push(artifact)
    return artifact
  }

  async removeUnpublishedImages(executionState) {
    const keys = [...executionState.generatedKeys].filter((key) => !executionState.publishedKeys.has(key))
    await Promise.allSettled(keys.map((key) => this.env.IMAGES.delete(key)))
  }

  async removeExecutionImages(promptId, executionState) {
    await Promise.allSettled([...executionState.generatedKeys].map((key) => this.env.IMAGES.delete(key)))
    this.sql.exec('DELETE FROM job_artifacts WHERE job_id = ?', promptId)
  }

  artifactOutputs(promptId) {
    const artifacts = this.rows(
      'SELECT node_id, output_filename, output_type FROM job_artifacts WHERE job_id = ? ORDER BY created_at',
      promptId
    )
    const outputs = {}
    for (const artifact of artifacts) {
      outputs[artifact.node_id] ||= { images: [] }
      outputs[artifact.node_id].images.push({
        filename: artifact.output_filename,
        subfolder: '',
        type: artifact.output_type
      })
    }
    return outputs
  }

  async trimHistory() {
    const maxHistory = clampInteger(this.env.MAX_HISTORY, 1, 1000, 100)
    const expired = this.rows(
      `SELECT id FROM jobs
       WHERE status IN ('completed', 'failed', 'cancelled')
       ORDER BY created_at DESC LIMIT -1 OFFSET ?`,
      maxHistory
    )
    for (const row of expired) {
      const objects = this.rows(
        `SELECT DISTINCT output_key FROM job_artifacts WHERE job_id = ? AND owns_object = 1
         UNION
         SELECT output_key FROM jobs
         WHERE id = ? AND output_key IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM job_artifacts WHERE job_id = ?)`,
        row.id,
        row.id,
        row.id
      )
      await Promise.all(objects.map((object) => this.env.IMAGES.delete(object.output_key)))
      this.sql.exec('DELETE FROM job_artifacts WHERE job_id = ?', row.id)
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

  async bootstrap(request) {
    const body = await request.json().catch(() => undefined)
    if (!isStoredUser(body?.user) || !isSessionId(body?.sessionId)) {
      return json({ error: 'Invalid session bootstrap' }, 400)
    }
    this.setMetadata('session_id', body.sessionId)
    this.setMetadata('auth_user', JSON.stringify(body.user))
    this.setMetadata('auth_expires_at', String(Date.now() + SESSION_TTL_SECONDS * 1000))
    return json({ ok: true })
  }

  async logout() {
    const sessionPrefix = `sessions/${this.sessionId()}/`
    const objects = this.rows(
      `SELECT output_key FROM uploads
       UNION
       SELECT output_key FROM job_artifacts WHERE owns_object = 1
       UNION
       SELECT output_key FROM jobs WHERE output_key IS NOT NULL`
    ).filter((object) => object.output_key.startsWith(sessionPrefix))
    await Promise.allSettled(objects.map((object) => this.env.IMAGES.delete(object.output_key)))
    this.sql.exec('DELETE FROM uploads')
    this.sql.exec('DELETE FROM job_artifacts')
    this.sql.exec('DELETE FROM jobs')
    this.sql.exec("DELETE FROM metadata WHERE key IN ('auth_user', 'auth_expires_at')")
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.close(1008, 'Signed out')
      } catch {
        // The socket may already be closed.
      }
    }
    return json({ ok: true })
  }

  authenticatedUser() {
    const expiresAt = Number(this.firstRow("SELECT value FROM metadata WHERE key = 'auth_expires_at'")?.value)
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return undefined
    const value = this.firstRow("SELECT value FROM metadata WHERE key = 'auth_user'")?.value
    try {
      const user = JSON.parse(value || '')
      return isStoredUser(user) ? user : undefined
    } catch {
      return undefined
    }
  }

  setMetadata(key, value) {
    this.sql.exec(
      'INSERT INTO metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      value
    )
  }
}

async function startSSO(request, env) {
  const corsHeaders = mainSiteCorsHeaders(request, env)
  if (!corsHeaders) return apiError('origin_not_allowed', 'This login request must come from ChickenDog.', 403)
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })
  if (request.method !== 'POST') {
    return withHeaders(apiError('method_not_allowed', 'Method not allowed.', 405), corsHeaders)
  }

  const token = bearerToken(request)
  if (!token) {
    return withHeaders(apiError('auth_required', 'Log in to ChickenDog first.', 401), corsHeaders)
  }

  try {
    assertSessionSecret(env.COMFY_SESSION_SECRET)
    const user = await provisionManagedUser(token, env)
    const ticket = await createLoginTicket(user, env.COMFY_SESSION_SECRET)
    const redirectUrl = new URL('/api/auth/callback', publicOrigin(env))
    redirectUrl.searchParams.set('ticket', ticket)
    return withHeaders(json({ redirectUrl: redirectUrl.toString() }), corsHeaders)
  } catch (error) {
    const status = error instanceof UpstreamError ? error.status : 503
    const code = error instanceof UpstreamError ? error.code : 'configuration_error'
    return withHeaders(apiError(code, errorMessage(error), status), corsHeaders)
  }
}

async function finishSSO(request, env, url) {
  if (request.method !== 'GET') return apiError('method_not_allowed', 'Method not allowed.', 405)

  const target = new URL('/', publicOrigin(env))
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer'
  })
  try {
    const user = await consumeLoginTicket(url.searchParams.get('ticket') || '', env.COMFY_SESSION_SECRET)
    const sessionId = crypto.randomUUID()
    const id = env.COMFY_SESSIONS.idFromName(sessionId)
    const response = await env.COMFY_SESSIONS.get(id).fetch('https://comfy.internal/__bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, user })
    })
    if (!response.ok) throw new Error('Could not initialize the Comfy session')
    headers.set('Set-Cookie', sessionCookie(sessionId))
  } catch {
    target.searchParams.set('auth_error', 'expired_ticket')
    headers.set('Set-Cookie', expiredSessionCookie())
  }
  headers.set('Location', target.toString())
  return new Response(null, { status: 302, headers })
}

async function logout(request, env) {
  if (request.method !== 'POST') return apiError('method_not_allowed', 'Method not allowed.', 405)
  if (!originAllowed(request, env.ALLOWED_ORIGIN)) {
    return apiError('origin_not_allowed', 'Origin not allowed.', 403)
  }

  const sessionId = sessionFromRequest(request)
  if (sessionId) {
    const id = env.COMFY_SESSIONS.idFromName(sessionId)
    await env.COMFY_SESSIONS.get(id).fetch('https://comfy.internal/__logout', { method: 'POST' })
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': expiredSessionCookie()
    }
  })
}

function sessionFromRequest(request) {
  const cookie = parseSessionCookie(request.headers.get('Cookie'))
  return isSessionId(cookie) ? cookie : undefined
}

function originAllowed(request, allowedOrigin) {
  if (!allowedOrigin) return true
  const origin = request.headers.get('Origin')
  return !origin || origin === allowedOrigin
}

function mainSiteCorsHeaders(request, env) {
  const origin = request.headers.get('Origin')
  const allowed = normalizedOrigin(env.MAIN_APP_ORIGIN || 'https://chickendog.cc')
  if (!origin || origin !== allowed) return undefined
  return {
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Max-Age': '600',
    Vary: 'Origin'
  }
}

function publicOrigin(env) {
  return normalizedOrigin(env.PUBLIC_ORIGIN || env.ALLOWED_ORIGIN || 'https://comfyui-gpt-image.pages.dev')
}

function sessionSecretConfigured(secret) {
  try {
    assertSessionSecret(secret)
    return true
  } catch {
    return false
  }
}

function normalizedOrigin(value) {
  return new URL(value).origin
}

function bearerToken(request) {
  const match = request.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/iu)
  return match?.[1]?.trim() || ''
}

function isStoredUser(value) {
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

function publicUser(user) {
  return {
    userId: user.userId,
    email: typeof user.email === 'string' ? user.email : '',
    displayName: typeof user.displayName === 'string' ? user.displayName : '',
    role: user.role === 'admin' ? 'admin' : 'user',
    groupId: user.groupId
  }
}

function authRequired() {
  return apiError('auth_required', 'Log in from ChickenDog before opening this workflow.', 401)
}

function apiError(code, message, status) {
  return json({ error: { code, message } }, status)
}

function withHeaders(response, headers) {
  const merged = new Headers(response.headers)
  for (const [name, value] of Object.entries(headers)) merged.set(name, value)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged
  })
}

function staticApiResponse(url, method) {
  if (method !== 'GET') return json({ error: 'Method not allowed' }, 405)
  if (url.pathname === '/api/extensions') return json(['/extensions/cloudflare/gpt-image.js'])
  if (url.pathname === '/api/workflow_templates') return json({})
  if (url.pathname === '/api/embeddings') return json([])
  if (url.pathname === '/api/features') {
    return json({ supports_preview_metadata: false, max_upload_size: MAX_UPLOAD_BYTES })
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
  return json({ error: 'Not found' }, 404)
}

function serverFeatureFlags() {
  return {
    supports_progress_text_metadata: false,
    supports_preview_metadata: false,
    supports_jobs_api: true
  }
}

function imageOutput(value, outputType = 'output') {
  const values = Array.isArray(value) ? value : [{ filename: value, outputType }]
  return {
    images: values.map((item) => ({
      filename: item.filename,
      subfolder: '',
      type: item.outputType || outputType
    }))
  }
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

function legacyHistoryEntry(row, outputs = undefined) {
  return {
    prompt: legacyQueueItem(row),
    outputs: outputs && Object.keys(outputs).length
      ? outputs
      : row.output_filename
        ? { [row.node_id]: imageOutput(row.output_filename) }
        : {},
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

function safePathPart(value, fallback) {
  const normalized = typeof value === 'string'
    ? value.trim().replace(/[^A-Za-z0-9_-]+/gu, '_').replace(/^_+|_+$/gu, '')
    : ''
  return (normalized || fallback).slice(0, 80)
}

function imageExtension(contentType) {
  if (contentType === 'image/jpeg') return 'jpeg'
  if (contentType === 'image/webp') return 'webp'
  return 'png'
}

function imageItems(value) {
  if (!value) return []
  if (value.type === 'IMAGE' && Array.isArray(value.images)) return value.images
  return [value]
}

function r2Asset(object, fallbackKind) {
  const metadata = object.customMetadata || {}
  const filename = metadata.filename || object.key.slice(object.key.lastIndexOf('/') + 1)
  return {
    key: object.key,
    filename,
    kind: metadata.kind || fallbackKind,
    contentType: object.httpMetadata?.contentType || 'application/octet-stream',
    width: Number(metadata.width) || 0,
    height: Number(metadata.height) || 0,
    hasAlpha: metadata.hasAlpha === 'true',
    size: object.size,
    uploaded: object.uploaded instanceof Date ? object.uploaded.getTime() : 0
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'Unknown error')
}

function normalizedUserDataContentType(value) {
  if (typeof value !== 'string' || !value.trim()) return 'application/octet-stream'
  return value.slice(0, 200)
}

function json(value, status = 200) {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store' }
  })
}
