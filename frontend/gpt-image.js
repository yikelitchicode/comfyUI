import { app } from '../../scripts/app.js'

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
  last_node_id: 1,
  last_link_id: 0,
  nodes: [
    {
      id: 1,
      type: 'GPTImage2',
      pos: [180, 120],
      size: [460, 430],
      flags: {},
      order: 0,
      mode: 0,
      inputs: [],
      outputs: [],
      properties: {
        'Node name for S&R': 'GPTImage2'
      },
      widgets_values: [
        'A cinematic editorial photograph with precise natural light and rich material detail',
        '1024x1024',
        'auto',
        'png'
      ]
    }
  ],
  links: [],
  groups: [],
  config: {},
  extra: {
    ds: { scale: 1, offset: [120, 80] }
  },
  version: 0.4
}

let replaced = false

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
    for (const delay of [0, 250, 1000, 2500]) {
      window.setTimeout(installDefaultWorkflow, delay)
    }
  }
})

