import { app } from '../../scripts/app.js'
import { api } from '../../scripts/api.js'

const STORAGE_KEY = 'cloudflare-gpt-image-default-v1'
const LEGACY_DEFAULT_TYPES = new Set([
  'CheckpointLoaderSimple',
  'CLIPLoader',
  'CLIPTextEncode',
  'EmptyLatentImage',
  'EmptySD3LatentImage',
  'KSampler',
  'ModelSamplingAuraFlow',
  'SaveImage',
  'UNETLoader',
  'VAEDecode',
  'VAELoader'
])

const DEFAULT_WORKFLOW = {
  last_node_id: 3,
  last_link_id: 2,
  nodes: [
    {
      id: 1,
      type: 'TextPrompt',
      pos: [80, 150],
      size: [360, 220],
      flags: {},
      order: 0,
      mode: 0,
      inputs: [],
      outputs: [{ name: 'text', type: 'STRING', links: [1], slot_index: 0 }],
      properties: {
        'Node name for S&R': 'TextPrompt'
      },
      widgets_values: [
        'A cinematic editorial photograph with precise natural light and rich material detail'
      ]
    },
    {
      id: 2,
      type: 'GPTImageGenerate',
      pos: [520, 150],
      size: [360, 260],
      flags: {},
      order: 1,
      mode: 0,
      inputs: [{ name: 'prompt', type: 'STRING', link: 1 }],
      outputs: [{ name: 'image', type: 'IMAGE', links: [2], slot_index: 0 }],
      properties: {
        'Node name for S&R': 'GPTImageGenerate'
      },
      widgets_values: [
        '1024x1024',
        'auto',
        'png',
        1
      ]
    },
    {
      id: 3,
      type: 'PreviewImage',
      pos: [960, 150],
      size: [360, 300],
      flags: {},
      order: 2,
      mode: 0,
      inputs: [{ name: 'image', type: 'IMAGE', link: 2 }],
      outputs: [{ name: 'image', type: 'IMAGE', links: [], slot_index: 0 }],
      properties: {
        'Node name for S&R': 'PreviewImage'
      },
      widgets_values: []
    }
  ],
  links: [
    [1, 1, 0, 2, 0, 'STRING'],
    [2, 2, 0, 3, 0, 'IMAGE']
  ],
  groups: [],
  config: {},
  extra: {
    ds: { scale: 0.9, offset: [80, 80] }
  },
  version: 0.4
}

let replaced = false
let latestOutput
const observedPromptIds = new Set()

function autoPinPreviousOutput(event) {
  const detail = event?.detail
  const nodeId = detail?.node
  const promptId = detail?.prompt_id
  const images = detail?.output?.images
  if ((typeof nodeId !== 'string' && typeof nodeId !== 'number') || !promptId || !Array.isArray(images)) return
  if (observedPromptIds.has(promptId)) return

  const current = images
    .filter((image) => typeof image?.filename === 'string' && image.filename)
    .map((image) => ({ filename: image.filename, type: image.type || 'output' }))
  if (current.length === 0) return

  observedPromptIds.add(promptId)
  if (observedPromptIds.size > 100) {
    const oldest = observedPromptIds.values().next().value
    observedPromptIds.delete(oldest)
  }
  const key = String(nodeId)
  if (latestOutput?.promptId !== promptId) pinImages(key, latestOutput?.images || [])
  latestOutput = { promptId, images: current }
}

function pinImages(sourceNodeId, images) {
  const graph = app.graph
  const source = graph?.getNodeById?.(sourceNodeId)
  const LiteGraph = globalThis.LiteGraph
  if (!graph || !source || !LiteGraph?.createNode || images.length === 0) return

  const existing = (graph._nodes || []).filter(
    (node) => String(node.properties?.cloudflare_pinned_from || '') === sourceNodeId
  ).length
  graph.beforeChange?.()
  try {
    for (const [index, image] of images.entries()) {
      const node = LiteGraph.createNode('LoadImage')
      if (!node) continue
      const position = existing + index
      const column = position % 3
      const row = Math.floor(position / 3)
      const sourceWidth = Number(source.size?.[0]) || 320
      node.pos = [
        Number(source.pos?.[0] || 0) + sourceWidth + 80 + column * 300,
        Number(source.pos?.[1] || 0) + row * 340
      ]
      node.title = `Previous result ${position + 1}`
      node.properties ||= {}
      node.properties.cloudflare_pinned_from = sourceNodeId
      graph.add(node)

      const widget = node.widgets?.find((candidate) => candidate.name === 'image')
      if (widget) {
        widget.value = image.filename
        widget.callback?.(image.filename, app.canvas, node, [0, 0], {})
      }
      const preview = new Image()
      preview.onload = () => graph.setDirtyCanvas?.(true, true)
      preview.src = `/api/view?filename=${encodeURIComponent(image.filename)}&type=input&subfolder=`
      node.imgs = [preview]
    }
  } finally {
    graph.afterChange?.()
    graph.setDirtyCanvas?.(true, true)
  }
}

function installDefaultWorkflow() {
  if (replaced || localStorage.getItem(STORAGE_KEY) === 'installed') return

  const nodes = app.graph?._nodes || []
  if (!nodes.length) return
  if (nodes.some((node) => node.type === 'GPTImage2')) {
    localStorage.setItem(STORAGE_KEY, 'installed')
    return
  }

  const looksLikeBundledDefault = nodes.some((node) => node.type === 'KSampler') &&
    nodes.every((node) => LEGACY_DEFAULT_TYPES.has(node.type))
  if (!looksLikeBundledDefault) return

  replaced = true
  localStorage.setItem(STORAGE_KEY, 'installed')
  void app.loadGraphData(structuredClone(DEFAULT_WORKFLOW), true, false)
}

app.registerExtension({
  name: 'cloudflare.GPTImage2',
  setup() {
    api.addEventListener('executed', autoPinPreviousOutput)
    for (const delay of [0, 250, 1000, 2500]) {
      window.setTimeout(installDefaultWorkflow, delay)
    }
  }
})
