import { app } from '../../scripts/app.js'
import { api } from '../../scripts/api.js'

const STORAGE_KEY = 'cloudflare-gpt-image-default-v1'
const STUDIO_STORAGE_KEY = 'cloudflare-gpt-image-studio-v1'
const STUDIO_ID = 'cloudflare-gpt-image-studio'
const MAX_HISTORY = 20
const SIZE_GUIDES = {
  '1024x1024': 'Square · flexible social / product',
  '1080x1080 (IG Post)': '1:1 · Instagram feed post',
  '1080x1350 (IG Portrait)': '4:5 · Instagram portrait post',
  '1080x1920 (IG Story)': '9:16 · Stories / vertical video cover',
  '1200x1300 (12:13 custom ratio)': '12:13 · editorial portrait',
  '2480x3508 (A4 Poster, 300 DPI)': 'A4 · print-ready at 300 DPI',
  '2896x4096 (A3 Poster, max quality)': 'A3 ratio · highest supported long edge',
  '2048x3072 (2:3 Poster)': '2:3 · classic poster composition',
  '2926x4096 (50x70 cm Poster)': '5:7 · 50 × 70 cm poster ratio',
  '2160x2880 (3:4 Poster)': '3:4 · editorial poster'
}
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
      size: [360, 300],
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
        1,
        ''
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
const studio = {
  activeTab: 'results',
  selected: [],
  latestBatch: [],
  history: loadHistory()
}

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
  recordStudioOutput(key, promptId, current)
}

function loadHistory() {
  try {
    const value = JSON.parse(localStorage.getItem(STUDIO_STORAGE_KEY) || '[]')
    return Array.isArray(value) ? value.slice(0, MAX_HISTORY) : []
  } catch {
    return []
  }
}

function saveHistory() {
  localStorage.setItem(STUDIO_STORAGE_KEY, JSON.stringify(studio.history.slice(0, MAX_HISTORY)))
}

function recordStudioOutput(nodeId, promptId, images) {
  studio.latestBatch = images.map((image) => ({ ...image, id: `${promptId}:${image.filename}` }))
  studio.selected = studio.selected.filter((id) => studio.latestBatch.some((image) => image.id === id))
  const node = app.graph?.getNodeById?.(nodeId)
  if (node?.type === 'GPTImageGenerate' || node?.type === 'GPTImageEdit' || node?.type === 'GPTImage2') {
    const snapshot = nodeSnapshot(node)
    if (snapshot.prompt) {
      studio.history = [
        { ...snapshot, promptId, nodeId, createdAt: Date.now(), images: studio.latestBatch },
        ...studio.history.filter((entry) => entry.promptId !== promptId)
      ].slice(0, MAX_HISTORY)
      saveHistory()
    }
  }
  renderStudio()
}

function nodeSnapshot(node) {
  return {
    prompt: promptForNode(node),
    size: widgetValue(node, 'size') || '1024x1024',
    quality: widgetValue(node, 'quality') || 'auto',
    outputFormat: widgetValue(node, 'output_format') || 'png',
    batchSize: widgetValue(node, 'batch_size') || 1,
    customSize: widgetValue(node, 'custom_size') || ''
  }
}

function widgetValue(node, name) {
  const widget = node.widgets?.find((candidate) => candidate.name === name)
  if (widget) return widget.value
  const indexes = node.type === 'GPTImage2'
    ? { size: 1, quality: 2, output_format: 3, batch_size: 4, custom_size: 5 }
    : { size: 0, quality: 1, output_format: 2, batch_size: 3, custom_size: 4 }
  return node.widgets_values?.[indexes[name]]
}

function promptForNode(node) {
  const promptWidget = node.widgets?.find((candidate) => candidate.name === 'prompt')
  if (promptWidget?.value) return String(promptWidget.value)
  const input = node.inputs?.find((candidate) => candidate.name === 'prompt')
  const link = input?.link === undefined ? undefined : app.graph?.links?.[input.link]
  const source = link && app.graph?.getNodeById?.(link.origin_id)
  return String(source?.widgets?.find((candidate) => candidate.name === 'text')?.value || source?.widgets_values?.[0] || '')
}

function setWidgetValue(node, name, value) {
  if (!node) return
  const widget = node.widgets?.find((candidate) => candidate.name === name)
  if (!widget) return
  widget.value = value
  widget.callback?.(value, app.canvas, node, [0, 0], {})
}

function imageUrl(image) {
  return `/api/view?filename=${encodeURIComponent(image.filename)}&type=${encodeURIComponent(image.type || 'output')}&subfolder=`
}

function injectStudioStyles() {
  if (document.getElementById(`${STUDIO_ID}-style`)) return
  const style = document.createElement('style')
  style.id = `${STUDIO_ID}-style`
  style.textContent = `
    #${STUDIO_ID}{position:fixed;right:18px;bottom:18px;z-index:20;width:min(400px,calc(100vw - 36px));color:#edf1f5;font:13px/1.4 Inter,system-ui,sans-serif}
    #${STUDIO_ID} button{font:inherit} #${STUDIO_ID} .cf-launch{margin-left:auto;display:flex;align-items:center;gap:8px;border:1px solid #53606b;background:#1a222a;color:#edf1f5;border-radius:6px;padding:9px 12px;box-shadow:0 10px 30px #0008;cursor:pointer}
    #${STUDIO_ID} .cf-panel{margin-top:8px;max-height:min(680px,calc(100vh - 100px));overflow:auto;border:1px solid #495560;border-radius:7px;background:#11181eeF;box-shadow:0 18px 48px #0009;backdrop-filter:blur(12px)}
    #${STUDIO_ID} .cf-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid #33404a} #${STUDIO_ID} .cf-head strong{font-size:14px;letter-spacing:0}
    #${STUDIO_ID} .cf-close,#${STUDIO_ID} .cf-tabs button{border:0;background:transparent;color:#aebac4;cursor:pointer} #${STUDIO_ID} .cf-close{font-size:19px;line-height:1}
    #${STUDIO_ID} .cf-tabs{display:grid;grid-template-columns:repeat(3,1fr);padding:6px;border-bottom:1px solid #33404a} #${STUDIO_ID} .cf-tabs button{padding:7px 4px;border-radius:4px} #${STUDIO_ID} .cf-tabs button[aria-selected=true]{background:#263643;color:#e8f4fa}
    #${STUDIO_ID} .cf-body{padding:12px} #${STUDIO_ID} .cf-note{margin:0;color:#94a4b1;font-size:12px} #${STUDIO_ID} .cf-section{margin-top:12px} #${STUDIO_ID} .cf-label{display:flex;justify-content:space-between;margin-bottom:6px;color:#aebbc6;font-size:11px;text-transform:uppercase;letter-spacing:.06em}
    #${STUDIO_ID} .cf-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px} #${STUDIO_ID} .cf-candidate{position:relative;min-width:0;aspect-ratio:1;border:2px solid transparent;border-radius:4px;overflow:hidden;background:#202a31;cursor:pointer} #${STUDIO_ID} .cf-candidate[data-selected=true]{border-color:#67c6d5} #${STUDIO_ID} .cf-candidate img{width:100%;height:100%;display:block;object-fit:cover}
    #${STUDIO_ID} .cf-chip{position:absolute;right:4px;bottom:4px;min-width:18px;padding:1px 4px;border-radius:3px;background:#071218dd;color:#d9f9ff;font-size:10px;text-align:center} #${STUDIO_ID} .cf-actions{display:flex;gap:7px;margin-top:9px} #${STUDIO_ID} .cf-action{flex:1;border:1px solid #45606c;border-radius:4px;background:#20313a;color:#ecf8fa;padding:7px;cursor:pointer} #${STUDIO_ID} .cf-action:disabled{opacity:.42;cursor:not-allowed}
    #${STUDIO_ID} .cf-compare{position:relative;aspect-ratio:16/10;overflow:hidden;border:1px solid #3a4852;border-radius:4px;background:#080d10} #${STUDIO_ID} .cf-compare img{width:100%;height:100%;object-fit:contain;position:absolute;inset:0} #${STUDIO_ID} .cf-compare .cf-overlay{clip-path:inset(0 50% 0 0)} #${STUDIO_ID} .cf-compare input{position:absolute;inset:auto 8px 8px;width:calc(100% - 16px);accent-color:#67c6d5}
    #${STUDIO_ID} .cf-template,#${STUDIO_ID} .cf-history{width:100%;display:flex;justify-content:space-between;align-items:center;gap:10px;border:1px solid #35434d;border-radius:4px;background:#182127;color:#e2e9ed;padding:9px;margin-bottom:7px;text-align:left;cursor:pointer} #${STUDIO_ID} .cf-template small,#${STUDIO_ID} .cf-history small{display:block;color:#95a4ae;margin-top:2px} #${STUDIO_ID} .cf-history{align-items:flex-start} #${STUDIO_ID} .cf-history span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #${STUDIO_ID} .cf-guide{padding:9px;border-left:3px solid #67c6d5;background:#17242b;color:#c7d7de;font-size:12px} #${STUDIO_ID} .cf-empty{padding:24px 8px;text-align:center;color:#82919d} @media (max-width:600px){#${STUDIO_ID}{right:10px;bottom:10px;width:calc(100vw - 20px)}}
  `
  document.head.append(style)
}

function mountStudio() {
  if (document.getElementById(STUDIO_ID)) return
  injectStudioStyles()
  const root = document.createElement('aside')
  root.id = STUDIO_ID
  root.innerHTML = '<button class="cf-launch" type="button" title="Open GPT Image studio"><i class="mdi mdi-image-multiple-outline"></i> Creative tools</button><section class="cf-panel" hidden></section>'
  document.body.append(root)
  root.querySelector('.cf-launch').addEventListener('click', () => {
    root.querySelector('.cf-panel').hidden = false
    root.querySelector('.cf-launch').hidden = true
    renderStudio()
  })
}

function renderStudio() {
  const root = document.getElementById(STUDIO_ID)
  const panel = root?.querySelector('.cf-panel')
  if (!panel || panel.hidden) return
  panel.replaceChildren()
  const header = document.createElement('div')
  header.className = 'cf-head'
  header.innerHTML = '<strong>GPT Image Studio</strong><button class="cf-close" type="button" title="Close creative tools" aria-label="Close">×</button>'
  header.querySelector('button').addEventListener('click', () => {
    panel.hidden = true
    root.querySelector('.cf-launch').hidden = false
  })
  panel.append(header, tabsElement(), tabBody())
}

function tabsElement() {
  const tabs = document.createElement('nav')
  tabs.className = 'cf-tabs'
  for (const [id, label] of [['results', 'Results'], ['templates', 'Templates'], ['history', 'History']]) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = label
    button.setAttribute('aria-selected', String(studio.activeTab === id))
    button.addEventListener('click', () => { studio.activeTab = id; renderStudio() })
    tabs.append(button)
  }
  return tabs
}

function tabBody() {
  const body = document.createElement('div')
  body.className = 'cf-body'
  if (studio.activeTab === 'templates') return renderTemplates(body)
  if (studio.activeTab === 'history') return renderHistory(body)
  return renderResults(body)
}

function renderResults(body) {
  const currentNode = selectedImageNode()
  const size = currentNode && (widgetValue(currentNode, 'custom_size') || widgetValue(currentNode, 'size'))
  const guide = document.createElement('div')
  guide.className = 'cf-guide'
  guide.textContent = size ? `${size} · ${SIZE_GUIDES[size] || customSizeGuide(size)}` : 'Select a GPT Image node to inspect its output size.'
  body.append(guide)
  if (!studio.latestBatch.length) {
    const empty = document.createElement('div')
    empty.className = 'cf-empty'
    empty.textContent = 'Generate a batch to compare candidates and continue with an edit.'
    body.append(empty)
    return body
  }
  const label = document.createElement('div')
  label.className = 'cf-label'
  label.innerHTML = `<span>Latest batch</span><span>${studio.selected.length}/2 selected</span>`
  body.append(label)
  const grid = document.createElement('div')
  grid.className = 'cf-grid'
  studio.latestBatch.forEach((image, index) => grid.append(candidateElement(image, index)))
  body.append(grid)
  const actions = document.createElement('div')
  actions.className = 'cf-actions'
  const edit = actionButton('Use in Edit', studio.selected.length === 1, () => createEditWorkflow(selectedImages()[0]))
  const clear = actionButton('Clear selection', studio.selected.length > 0, () => { studio.selected = []; renderStudio() })
  actions.append(edit, clear)
  body.append(actions)
  if (studio.selected.length === 2) body.append(compareElement(...selectedImages()))
  return body
}

function candidateElement(image, index) {
  const button = document.createElement('button')
  button.className = 'cf-candidate'
  button.type = 'button'
  button.dataset.selected = String(studio.selected.includes(image.id))
  button.title = `Result ${index + 1}`
  const preview = document.createElement('img')
  preview.src = imageUrl(image)
  preview.alt = `Generated result ${index + 1}`
  const chip = document.createElement('span')
  chip.className = 'cf-chip'
  chip.textContent = String(index + 1)
  button.append(preview, chip)
  button.addEventListener('click', () => {
    studio.selected = studio.selected.includes(image.id)
      ? studio.selected.filter((id) => id !== image.id)
      : [...studio.selected.slice(-1), image.id]
    renderStudio()
  })
  return button
}

function selectedImages() {
  return studio.selected.map((id) => studio.latestBatch.find((image) => image.id === id)).filter(Boolean)
}

function actionButton(label, enabled, action) {
  const button = document.createElement('button')
  button.className = 'cf-action'
  button.type = 'button'
  button.textContent = label
  button.disabled = !enabled
  button.addEventListener('click', action)
  return button
}

function compareElement(left, right) {
  const section = document.createElement('section')
  section.className = 'cf-section'
  const label = document.createElement('div')
  label.className = 'cf-label'
  label.textContent = 'Compare selected results'
  const compare = document.createElement('div')
  compare.className = 'cf-compare'
  const base = document.createElement('img')
  base.src = imageUrl(right)
  base.alt = 'Comparison result B'
  const overlay = document.createElement('img')
  overlay.className = 'cf-overlay'
  overlay.src = imageUrl(left)
  overlay.alt = 'Comparison result A'
  const slider = document.createElement('input')
  slider.type = 'range'
  slider.min = '0'
  slider.max = '100'
  slider.value = '50'
  slider.setAttribute('aria-label', 'Comparison position')
  slider.addEventListener('input', () => { overlay.style.clipPath = `inset(0 ${100 - Number(slider.value)}% 0 0)` })
  compare.append(base, overlay, slider)
  section.append(label, compare)
  return section
}

function renderTemplates(body) {
  const note = document.createElement('p')
  note.className = 'cf-note'
  note.textContent = 'Templates replace the current canvas. Your existing work is preserved in ComfyUI workflow history.'
  body.append(note)
  for (const template of workflowTemplates()) {
    const button = document.createElement('button')
    button.className = 'cf-template'
    button.type = 'button'
    button.innerHTML = `<span><strong>${template.name}</strong><small>${template.detail}</small></span><i class="mdi mdi-arrow-right"></i>`
    button.addEventListener('click', () => void app.loadGraphData(template.graph(), true, false))
    body.append(button)
  }
  return body
}

function renderHistory(body) {
  if (!studio.history.length) {
    const empty = document.createElement('div')
    empty.className = 'cf-empty'
    empty.textContent = 'Completed GPT Image prompts will appear here on this browser.'
    body.append(empty)
    return body
  }
  studio.history.forEach((entry) => {
    const button = document.createElement('button')
    button.className = 'cf-history'
    button.type = 'button'
    const when = new Date(entry.createdAt).toLocaleString()
    button.innerHTML = `<span><strong>${escapeHtml(entry.prompt)}</strong><small>${escapeHtml(entry.size)} · ${when}</small></span><i class="mdi mdi-restore"></i>`
    button.addEventListener('click', () => restoreHistory(entry))
    body.append(button)
  })
  return body
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
}

function customSizeGuide(size) {
  const match = /^(\d+)x(\d+)$/u.exec(String(size))
  if (!match) return 'Choose a preset or enter width × height.'
  const ratio = (Number(match[1]) / Number(match[2])).toFixed(2)
  return `${ratio}:1 aspect ratio · custom size`
}

function selectedImageNode() {
  const selected = Object.values(app.canvas?.selected_nodes || {})
  return selected.find((node) => ['GPTImageGenerate', 'GPTImageEdit', 'GPTImage2'].includes(node.type)) ||
    app.graph?._nodes?.find((node) => ['GPTImageGenerate', 'GPTImageEdit', 'GPTImage2'].includes(node.type))
}

function restoreHistory(entry) {
  const node = selectedImageNode()
  if (!node) return
  setWidgetValue(node, 'size', entry.size)
  setWidgetValue(node, 'quality', entry.quality)
  setWidgetValue(node, 'output_format', entry.outputFormat)
  setWidgetValue(node, 'batch_size', entry.batchSize)
  setWidgetValue(node, 'custom_size', entry.customSize)
  const prompt = node.widgets?.find((candidate) => candidate.name === 'prompt')
  if (prompt) setWidgetValue(node, 'prompt', entry.prompt)
  else setWidgetValue(promptSource(node), 'text', entry.prompt)
  app.canvas?.setDirtyCanvas?.(true, true)
}

function promptSource(node) {
  const input = node?.inputs?.find((candidate) => candidate.name === 'prompt')
  const link = input?.link === undefined ? undefined : app.graph?.links?.[input.link]
  return link && app.graph?.getNodeById?.(link.origin_id)
}

function createEditWorkflow(image) {
  const graph = app.graph
  const LiteGraph = globalThis.LiteGraph
  if (!graph || !LiteGraph?.createNode || !image) return
  const source = LiteGraph.createNode('LoadImage')
  const prompt = LiteGraph.createNode('TextPrompt')
  const edit = LiteGraph.createNode('GPTImageEdit')
  const preview = LiteGraph.createNode('PreviewImage')
  if (!source || !prompt || !edit || !preview) return
  const anchor = selectedImageNode()
  const x = Number(anchor?.pos?.[0] || 80) + 440
  const y = Number(anchor?.pos?.[1] || 80)
  graph.beforeChange?.()
  try {
    source.pos = [x, y]
    prompt.pos = [x, y + 260]
    edit.pos = [x + 410, y + 110]
    preview.pos = [x + 820, y + 110]
    graph.add(source); graph.add(prompt); graph.add(edit); graph.add(preview)
    setWidgetValue(source, 'image', image.filename)
    setWidgetValue(prompt, 'text', 'Describe the change you want to make')
    prompt.connect(0, edit, 0)
    source.connect(0, edit, 1)
    edit.connect(0, preview, 0)
  } finally {
    graph.afterChange?.()
    graph.setDirtyCanvas?.(true, true)
  }
}

function workflowTemplates() {
  return [
    ['IG Post', '1:1 social post with a ready-to-edit prompt', '1080x1080 (IG Post)'],
    ['IG Story', '9:16 vertical story or cover', '1080x1920 (IG Story)'],
    ['A4 Poster', 'A4 portrait at print-ready dimensions', '2480x3508 (A4 Poster, 300 DPI)']
  ].map(([name, detail, size]) => ({ name, detail, graph: () => generationWorkflow(size) })).concat({
    name: 'Product Edit',
    detail: 'Load a product image, describe the change, then preview',
    graph: editWorkflow
  })
}

function generationWorkflow(size) {
  const graph = structuredClone(DEFAULT_WORKFLOW)
  graph.nodes[0].widgets_values = ['Describe the subject, setting, composition, materials, and lighting']
  graph.nodes[1].widgets_values = [size, 'auto', 'png', 1, '']
  return graph
}

function editWorkflow() {
  return {
    last_node_id: 4, last_link_id: 3, groups: [], config: {}, version: 0.4,
    nodes: [
      { id: 1, type: 'LoadImage', pos: [80, 160], size: [300, 220], flags: {}, order: 0, mode: 0, inputs: [], outputs: [{ name: 'image', type: 'IMAGE', links: [2], slot_index: 0 }], properties: { 'Node name for S&R': 'LoadImage' }, widgets_values: [] },
      { id: 2, type: 'TextPrompt', pos: [80, 440], size: [360, 220], flags: {}, order: 1, mode: 0, inputs: [], outputs: [{ name: 'text', type: 'STRING', links: [1], slot_index: 0 }], properties: { 'Node name for S&R': 'TextPrompt' }, widgets_values: ['Describe the precise edit'] },
      { id: 3, type: 'GPTImageEdit', pos: [500, 230], size: [380, 360], flags: {}, order: 2, mode: 0, inputs: [{ name: 'prompt', type: 'STRING', link: 1 }, { name: 'image_1', type: 'IMAGE', link: 2 }], outputs: [{ name: 'image', type: 'IMAGE', links: [3], slot_index: 0 }], properties: { 'Node name for S&R': 'GPTImageEdit' }, widgets_values: ['1024x1024', 'auto', 'png', 1, ''] },
      { id: 4, type: 'PreviewImage', pos: [960, 230], size: [360, 300], flags: {}, order: 3, mode: 0, inputs: [{ name: 'image', type: 'IMAGE', link: 3 }], outputs: [{ name: 'image', type: 'IMAGE', links: [], slot_index: 0 }], properties: { 'Node name for S&R': 'PreviewImage' }, widgets_values: [] }
    ],
    links: [[1, 2, 0, 3, 0, 'STRING'], [2, 1, 0, 3, 1, 'IMAGE'], [3, 3, 0, 4, 0, 'IMAGE']],
    extra: { ds: { scale: 0.8, offset: [80, 80] } }
  }
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
    mountStudio()
    for (const delay of [0, 250, 1000, 2500]) {
      window.setTimeout(installDefaultWorkflow, delay)
    }
  }
})
