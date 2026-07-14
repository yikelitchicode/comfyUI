const MODEL_FALLBACKS = [
  'gpt-image-1',
  'gpt-image-1.5',
  'gpt-image-2',
  'grok-2-image',
  'grok-imagine-image',
  'grok-imagine-image-quality'
]

const SIZE_MATRIX = {
  '1k': {
    '1:1': '1024x1024', '16:9': '1024x576', '9:16': '576x1024', '4:3': '1024x768',
    '3:4': '768x1024', '3:2': '1008x672', '2:3': '672x1008'
  },
  '2k': {
    '1:1': '2048x2048', '16:9': '2048x1152', '9:16': '1152x2048', '4:3': '2048x1536',
    '3:4': '1536x2048', '3:2': '2016x1344', '2:3': '1344x2016'
  },
  '4k': {
    '1:1': '2880x2880', '16:9': '3840x2160', '9:16': '2160x3840', '4:3': '2880x2160',
    '3:4': '2160x2880', '3:2': '3264x2176', '2:3': '2176x3264'
  }
}

const elements = {
  app: document.querySelector('#app'),
  authGate: document.querySelector('#auth-gate'),
  connectionState: document.querySelector('#connection-state'),
  userLabel: document.querySelector('#user-label'),
  logoutButton: document.querySelector('#logout-button'),
  resetButton: document.querySelector('#reset-button'),
  form: document.querySelector('#generation-form'),
  prompt: document.querySelector('#prompt'),
  promptCount: document.querySelector('#prompt-count'),
  model: document.querySelector('#model'),
  aspectRatio: document.querySelector('#aspect-ratio'),
  quality: document.querySelector('#quality'),
  format: document.querySelector('#format'),
  computedSize: document.querySelector('#computed-size'),
  promptNodeValue: document.querySelector('#prompt-node-value'),
  modelNodeValue: document.querySelector('#model-node-value'),
  sizeNodeValue: document.querySelector('#size-node-value'),
  message: document.querySelector('#form-message'),
  generateButton: document.querySelector('#generate-button'),
  resultEmpty: document.querySelector('#result-empty'),
  resultLoading: document.querySelector('#result-loading'),
  progressTitle: document.querySelector('#progress-title'),
  progressDetail: document.querySelector('#progress-detail'),
  resultFigure: document.querySelector('#result-figure'),
  resultImage: document.querySelector('#result-image'),
  resultCaption: document.querySelector('#result-caption'),
  downloadLink: document.querySelector('#download-link')
}

let models = [...MODEL_FALLBACKS]
let generating = false

function selectedResolution() {
  return document.querySelector('input[name="resolution"]:checked')?.value || '2k'
}

function selectedSize() {
  return SIZE_MATRIX[selectedResolution()][elements.aspectRatio.value]
}

function updateWorkflowSummary() {
  const prompt = elements.prompt.value.trim()
  elements.promptCount.textContent = String(elements.prompt.value.length)
  elements.promptNodeValue.textContent = prompt || 'Describe the image to create'
  elements.modelNodeValue.textContent = elements.model.value || 'gpt-image-2'
  elements.computedSize.textContent = selectedSize().replace('x', ' × ')
  elements.sizeNodeValue.textContent = `${selectedSize().replace('x', ' × ')} · ${elements.format.value.toUpperCase()}`
}

function populateModels(nextModels, selectedModel = 'gpt-image-2') {
  models = Array.isArray(nextModels) && nextModels.length ? nextModels : MODEL_FALLBACKS
  elements.model.replaceChildren(...models.map((model) => {
    const option = document.createElement('option')
    option.value = model
    option.textContent = model
    return option
  }))
  elements.model.value = models.includes(selectedModel) ? selectedModel : models[0]
}

function setConnectionState(state, label) {
  elements.connectionState.dataset.state = state
  elements.connectionState.textContent = label
}

function showMessage(message) {
  elements.message.textContent = message
  elements.message.hidden = !message
}

function setGenerating(active) {
  generating = active
  elements.generateButton.disabled = active
  elements.generateButton.textContent = active ? 'Running workflow…' : 'Run workflow'
  elements.resultEmpty.hidden = true
  elements.resultFigure.hidden = true
  elements.resultLoading.hidden = !active
}

function showResult(source, caption) {
  setGenerating(false)
  elements.resultImage.src = source
  elements.downloadLink.href = source
  elements.downloadLink.download = `chickendog-flow-${Date.now()}.${elements.format.value}`
  elements.resultCaption.textContent = caption
  elements.resultFigure.hidden = false
  elements.resultEmpty.hidden = true
}

function showEmptyResult() {
  elements.resultLoading.hidden = true
  elements.resultFigure.hidden = true
  elements.resultEmpty.hidden = false
}

function imageFromJson(body) {
  const item = Array.isArray(body?.data) ? body.data[0] : undefined
  if (typeof item?.b64_json === 'string' && item.b64_json) {
    return `data:image/${elements.format.value};base64,${item.b64_json}`
  }
  if (typeof item?.url === 'string' && item.url) {
    return item.url
  }
  return undefined
}

async function imageFromEventStream(response) {
  if (!response.body) throw new Error('The image stream did not return a body.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let imageSource

  while (true) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
    const blocks = buffer.split(/\r?\n\r?\n/u)
    buffer = blocks.pop() || ''

    for (const block of blocks) {
      const data = block.split(/\r?\n/u)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('')
      if (!data || data === '[DONE]') continue
      const event = JSON.parse(data)
      const partial = event.partial_image_b64 || event.b64_json
      if (typeof partial === 'string' && partial) {
        imageSource = `data:image/${elements.format.value};base64,${partial}`
        elements.progressTitle.textContent = event.type?.includes('partial') ? 'Preview received' : 'Finalizing output'
        elements.progressDetail.textContent = 'The provider returned image data. Preparing the result.'
      }
      if (event.error?.message) throw new Error(event.error.message)
    }
    if (done) break
  }

  if (!imageSource) throw new Error('The provider completed without returning an image.')
  return imageSource
}

async function errorFromResponse(response) {
  const text = await response.text().catch(() => '')
  try {
    const body = JSON.parse(text)
    return body?.error?.message || body?.message || `Generation failed (${response.status}).`
  } catch {
    return text || `Generation failed (${response.status}).`
  }
}

async function runWorkflow(event) {
  event.preventDefault()
  if (generating) return
  const prompt = elements.prompt.value.trim()
  if (!prompt) {
    showMessage('Enter a prompt before running this workflow.')
    elements.prompt.focus()
    return
  }

  showMessage('')
  setGenerating(true)
  elements.progressTitle.textContent = 'Generating image'
  elements.progressDetail.textContent = `${elements.model.value} · ${selectedSize().replace('x', ' × ')}`

  try {
    const response = await fetch('/api/images/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        model: elements.model.value,
        size: selectedSize(),
        quality: elements.quality.value,
        output_format: elements.format.value
      })
    })
    if (!response.ok) throw new Error(await errorFromResponse(response))

    const contentType = response.headers.get('content-type') || ''
    const source = contentType.includes('text/event-stream')
      ? await imageFromEventStream(response)
      : imageFromJson(await response.json())
    if (!source) throw new Error('The provider response did not contain an image.')
    showResult(source, `${elements.model.value} · ${selectedSize().replace('x', ' × ')}`)
  } catch (error) {
    setGenerating(false)
    showEmptyResult()
    showMessage(error instanceof Error ? error.message : 'The workflow could not be completed.')
  }
}

async function logout() {
  await fetch('/api/logout', { method: 'POST' }).catch(() => undefined)
  window.location.assign('https://chickendog.cc/dashboard')
}

function resetWorkflow() {
  elements.form.reset()
  elements.model.value = models.includes('gpt-image-2') ? 'gpt-image-2' : models[0]
  showMessage('')
  showEmptyResult()
  updateWorkflowSummary()
}

async function bootstrap() {
  try {
    const response = await fetch('/api/session', { cache: 'no-store' })
    if (response.status === 401) {
      elements.authGate.hidden = false
      setConnectionState('offline', 'Sign-in required')
      return
    }
    if (!response.ok) throw new Error(`Session check failed (${response.status}).`)
    const body = await response.json()
    populateModels(body.models, body.defaultModel)
    elements.userLabel.textContent = body.user?.displayName || body.user?.email || 'ChickenDog user'
    setConnectionState('online', 'Connected')
    updateWorkflowSummary()
  } catch (error) {
    elements.authGate.hidden = false
    setConnectionState('offline', 'Unavailable')
    document.querySelector('.auth-dialog p').textContent = error instanceof Error ? error.message : 'The workspace is unavailable.'
  } finally {
    elements.app.ariaBusy = 'false'
  }
}

elements.form.addEventListener('submit', runWorkflow)
elements.form.addEventListener('input', updateWorkflowSummary)
elements.form.addEventListener('change', updateWorkflowSummary)
elements.logoutButton.addEventListener('click', logout)
elements.resetButton.addEventListener('click', resetWorkflow)

void bootstrap()
