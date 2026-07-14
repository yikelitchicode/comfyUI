import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import extract from 'extract-zip'

const FRONTEND_VERSION = '1.48.2'
const FRONTEND_SHA256 = 'd19392226de8bf2605aa9272df377edfa9dfad973d2a9c9011afc509b804195c'
const FRONTEND_URL = `https://github.com/Comfy-Org/ComfyUI_frontend/releases/download/v${FRONTEND_VERSION}/dist.zip`

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cacheDir = path.join(root, '.cache')
const archive = path.join(cacheDir, `comfyui-frontend-${FRONTEND_VERSION}.zip`)
const dist = path.join(root, 'dist')

await mkdir(cacheDir, { recursive: true })

let bytes
try {
  bytes = await readFile(archive)
} catch {
  const response = await fetch(FRONTEND_URL, { redirect: 'follow' })
  if (!response.ok) throw new Error(`Frontend download failed: ${response.status} ${response.statusText}`)
  bytes = Buffer.from(await response.arrayBuffer())
  await writeFile(archive, bytes)
}

const digest = createHash('sha256').update(bytes).digest('hex')
if (digest !== FRONTEND_SHA256) {
  throw new Error(`Frontend checksum mismatch: expected ${FRONTEND_SHA256}, received ${digest}`)
}

await rm(dist, { recursive: true, force: true })
await mkdir(dist, { recursive: true })
await extract(archive, { dir: dist })

const extensionDir = path.join(dist, 'extensions', 'cloudflare')
await mkdir(extensionDir, { recursive: true })
await writeFile(
  path.join(extensionDir, 'gpt-image.js'),
  await readFile(path.join(root, 'frontend', 'gpt-image.js'))
)
await writeFile(
  path.join(dist, '_routes.json'),
  `${JSON.stringify({ version: 1, include: ['/api/*', '/ws'], exclude: [] }, null, 2)}\n`
)
await writeFile(path.join(dist, 'user.css'), '')

console.log(`Prepared official ComfyUI frontend v${FRONTEND_VERSION} in ${dist}`)
