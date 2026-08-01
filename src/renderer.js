const state = {
  rootPath: null,
  segments: [],
  totals: null,
  scanVersion: 0,
  trim: null,
  tools: null,
  processingView: 'all',
  expandedSegments: new Set(),
  toastTimer: null
}

const browseButton = document.querySelector('#browse-button')
const scanButton = document.querySelector('#scan-button')
const sourcePath = document.querySelector('#source-path')
const startDate = document.querySelector('#start-date')
const startTime = document.querySelector('#start-time')
const endDate = document.querySelector('#end-date')
const endTime = document.querySelector('#end-time')
const emptyState = document.querySelector('#empty-state')
const loadingState = document.querySelector('#loading-state')
const resultsHeading = document.querySelector('#results-heading')
const resultsSummary = document.querySelector('#results-summary')
const segmentsList = document.querySelector('#segments-list')
const processingTabs = document.querySelector('#processing-tabs')
const nameDialog = document.querySelector('#name-dialog')
const nameForm = document.querySelector('#name-form')
const clipName = document.querySelector('#clip-name')
const filenamePreview = document.querySelector('#filename-preview')
const progressDialog = document.querySelector('#progress-dialog')
const progressTitle = document.querySelector('#progress-title')
const progressPhase = document.querySelector('#progress-phase')
const progressBar = document.querySelector('#progress-bar')
const progressPercent = document.querySelector('#progress-percent')
const progressTrack = document.querySelector('.progress-track')
const cancelJobButton = document.querySelector('#cancel-job')
const trimDialog = document.querySelector('#trim-dialog')
const trimVideo = document.querySelector('#trim-video')
const trimName = document.querySelector('#trim-name')
const videoFallback = document.querySelector('#video-fallback')
const currentTime = document.querySelector('#current-time')
const startRange = document.querySelector('#start-range')
const endRange = document.querySelector('#end-range')
const startOutput = document.querySelector('#start-output')
const endOutput = document.querySelector('#end-output')
const errorDialog = document.querySelector('#error-dialog')
const errorMessage = document.querySelector('#error-message')
const toast = document.querySelector('#toast')
const toolsDialog = document.querySelector('#tools-dialog')
const toolsButton = document.querySelector('#tools-button')

function getFilterMode() {
  return document.querySelector('input[name="filter-mode"]:checked').value
}

function getFilters() {
  return {
    mode: getFilterMode(),
    startDate: startDate.value,
    startTime: startTime.value,
    endDate: endDate.value,
    endTime: endTime.value
  }
}

function updateFilterControls() {
  const showRange = getFilterMode() === 'range'
  startDate.disabled = !showRange
  startTime.disabled = !showRange || !startDate.value
  endDate.disabled = !showRange
  endTime.disabled = !showRange || !endDate.value
}

function formatDate(dateValue) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  }).format(new Date(dateValue))
}

function formatClock(dateValue) {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(dateValue))
}

function formatDuration(milliseconds) {
  const totalMinutes = Math.max(1, Math.round(milliseconds / 60000))
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60

  if (hours === 0) {
    return `${minutes} min`
  }

  return `${hours} hr ${minutes} min`
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`
  }

  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }

  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatVideoTime(seconds) {
  if (!Number.isFinite(seconds)) {
    return '00:00'
  }

  const wholeSeconds = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(wholeSeconds / 3600)
  const minutes = Math.floor((wholeSeconds % 3600) / 60)
  const remainder = wholeSeconds % 60

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
  }

  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
}

function parseVideoTime(value) {
  const parts = value.trim().split(':').map(Number)

  if (parts.length < 1 || parts.length > 3 || parts.some((part) => !Number.isFinite(part) || part < 0)) {
    return null
  }

  if (parts.length > 1 && parts.slice(1).some((part) => part >= 60)) {
    return null
  }

  if (parts.length === 1) {
    return parts[0]
  }

  if (parts.length === 2) {
    return parts[0] * 60 + parts[1]
  }

  return parts[0] * 3600 + parts[1] * 60 + parts[2]
}

function formatFilenamePrefix(dateValue) {
  const date = new Date(dateValue)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day}_${hours}-${minutes}`
}

function cleanPreviewName(name) {
  return name
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
}

function readableError(error) {
  const message = error?.message || String(error)
  return message
    .replace(/^Error invoking remote method '[^']+': Error: /, '')
    .replace(/^Error: /, '')
}

function showError(error) {
  errorMessage.textContent = readableError(error)

  if (!errorDialog.open) {
    errorDialog.showModal()
  }
}

function showToast(message) {
  clearTimeout(state.toastTimer)
  toast.textContent = message
  toast.classList.remove('hidden')
  state.toastTimer = setTimeout(() => toast.classList.add('hidden'), 6500)
}

function makeButton(label, className, action) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = className
  button.textContent = label
  button.addEventListener('click', action)
  return button
}

function createThumbnail(segment) {
  const thumbnail = document.createElement('div')
  thumbnail.className = 'segment-thumbnail thumbnail-loading'
  thumbnail.dataset.thumbnail = segment.id
  const placeholder = document.createElement('span')
  placeholder.className = 'thumbnail-placeholder'
  const camera = document.createElement('i')
  const label = document.createElement('span')
  label.textContent = 'Loading preview'
  placeholder.append(camera, label)
  thumbnail.append(placeholder)
  return thumbnail
}

function createProcessingState(segment) {
  const status = document.createElement('span')
  status.className = 'processing-state'

  if (segment.processed) {
    status.classList.add('processed')
    status.textContent = 'Processed'
  } else if (segment.processedCount > 0) {
    status.classList.add('partial')
    status.textContent = `${segment.processedCount} of ${segment.clipCount} processed`
  } else {
    status.textContent = 'Unprocessed'
  }

  return status
}

function createClipList(segment) {
  const list = document.createElement('div')
  list.className = 'clip-list'

  if (!state.expandedSegments.has(segment.id)) {
    list.classList.add('hidden')
  }

  for (const clip of segment.clips) {
    const row = document.createElement('div')
    row.className = 'clip-row'
    const time = document.createElement('span')
    time.className = 'clip-time'
    time.textContent = formatClock(clip.recordedAt)
    const name = document.createElement('span')
    name.className = 'clip-name'
    name.textContent = clip.fileName
    name.title = clip.fileName
    const cameras = document.createElement('span')
    cameras.className = 'clip-cameras'
    cameras.textContent = clip.hasRear ? 'Front + rear' : 'Front only'
    const processingButton = makeButton(
      clip.processed ? 'Processed ✓' : 'Mark processed',
      `mini-button clip-process-button${clip.processed ? ' active' : ''}`,
      () => setProcessingState(segment, 'clip', !clip.processed, clip.key, processingButton)
    )
    processingButton.title = clip.processed ? 'Click to mark this clip unprocessed' : 'Mark this clip processed'
    row.append(time, name, cameras, processingButton)
    list.append(row)
  }

  return list
}

function renderSegment(segment) {
  const card = document.createElement('article')
  card.className = 'segment-card'
  const thumbnail = createThumbnail(segment)

  const timeBlock = document.createElement('div')
  timeBlock.className = 'segment-time'
  const date = document.createElement('span')
  date.className = 'segment-date'
  date.textContent = formatDate(segment.start)
  const hours = document.createElement('span')
  hours.className = 'segment-hours'
  hours.textContent = `${formatClock(segment.start)} – ${formatClock(segment.end)}`
  timeBlock.append(date, hours)

  const details = document.createElement('div')
  details.className = 'segment-details'
  const primaryDetails = document.createElement('p')
  primaryDetails.textContent = `${formatDuration(segment.durationMs)} · ${segment.clipCount} clips · ${formatBytes(segment.totalSize)}`
  details.append(createProcessingState(segment), primaryDetails)

  if (segment.pairedCount === segment.clipCount) {
    const cameraDetails = document.createElement('p')
    cameraDetails.textContent = `${segment.pairedCount} complete front and rear pairs`
    details.append(cameraDetails)
  } else {
    const warning = document.createElement('p')
    warning.className = 'pair-warning'
    warning.textContent = `${segment.clipCount - segment.pairedCount} rear clip${segment.clipCount - segment.pairedCount === 1 ? '' : 's'} missing · merge unavailable`
    details.append(warning)
  }

  const actions = document.createElement('div')
  actions.className = 'segment-actions'
  const playButton = makeButton('Play in VLC', 'secondary-button', () => playSegment(segment))
  const mergeButton = makeButton('Merge & trim', 'primary-button', () => beginMerge(segment))
  mergeButton.disabled = segment.pairedCount !== segment.clipCount
  mergeButton.title = mergeButton.disabled ? 'A rear recording is missing for one or more front clips.' : ''
  const clipsButton = makeButton(
    state.expandedSegments.has(segment.id) ? 'Hide clips' : 'Show clips',
    'text-button',
    () => {
      if (state.expandedSegments.has(segment.id)) {
        state.expandedSegments.delete(segment.id)
        clipList.classList.add('hidden')
        clipsButton.textContent = 'Show clips'
      } else {
        state.expandedSegments.add(segment.id)
        clipList.classList.remove('hidden')
        clipsButton.textContent = 'Hide clips'
      }
    }
  )
  const processingButton = makeButton(
    segment.processed ? 'Mark unprocessed' : 'Mark processed',
    `secondary-button processing-action${segment.processed ? ' active' : ''}`,
    () => setProcessingState(segment, 'segment', !segment.processed, null, processingButton)
  )
  const deleteButton = makeButton('Delete', 'text-button danger-text', () => deleteSegment(segment))
  const clipList = createClipList(segment)
  actions.append(playButton, mergeButton, clipsButton, processingButton, deleteButton)

  card.append(thumbnail, timeBlock, details, actions, clipList)
  return card
}

async function loadThumbnails(version, visibleSegments = state.segments) {
  const segments = [...visibleSegments]
  let nextIndex = 0

  const loadNext = async () => {
    while (nextIndex < segments.length) {
      const segment = segments[nextIndex]
      nextIndex += 1
      const thumbnail = document.querySelector(`[data-thumbnail="${segment.id}"]`)

      if (!thumbnail) {
        continue
      }

      try {
        const imageUrl = await window.dashcam.getSegmentThumbnail(segment.id)

        if (version !== state.scanVersion || !thumbnail.isConnected) {
          continue
        }

        thumbnail.classList.remove('thumbnail-loading')

        if (imageUrl) {
          const image = document.createElement('img')
          image.src = imageUrl
          image.alt = `Front camera preview from ${formatClock(segment.start)}`
          thumbnail.replaceChildren(image)
        } else {
          thumbnail.querySelector('.thumbnail-placeholder span').textContent = 'No preview'
        }
      } catch {
        thumbnail.classList.remove('thumbnail-loading')
        thumbnail.querySelector('.thumbnail-placeholder span').textContent = 'No preview'
      }
    }
  }

  const workerCount = Math.min(3, segments.length)
  await Promise.all(Array.from({ length: workerCount }, loadNext))
}

function getVisibleSegments() {
  if (state.processingView === 'processed') {
    return state.segments.filter((segment) => segment.processed)
  }

  if (state.processingView === 'unprocessed') {
    return state.segments.filter((segment) => !segment.processed)
  }

  return state.segments
}

function updateProcessingTabs() {
  const processedCount = state.segments.filter((segment) => segment.processed).length
  const unprocessedCount = state.segments.length - processedCount
  document.querySelector('#all-count').textContent = String(state.segments.length)
  document.querySelector('#unprocessed-count').textContent = String(unprocessedCount)
  document.querySelector('#processed-count').textContent = String(processedCount)

  for (const tab of document.querySelectorAll('.processing-tab')) {
    const active = tab.dataset.processingView === state.processingView
    tab.classList.toggle('active', active)
    tab.setAttribute('aria-selected', String(active))
  }
}

function renderResults() {
  segmentsList.replaceChildren()
  loadingState.classList.add('hidden')

  if (!state.rootPath) {
    resultsHeading.classList.add('hidden')
    processingTabs.classList.add('hidden')
    emptyState.classList.remove('hidden')
    return
  }

  resultsHeading.classList.remove('hidden')
  processingTabs.classList.remove('hidden')
  updateProcessingTabs()
  const visibleSegments = getVisibleSegments()

  if (state.segments.length === 0) {
    emptyState.querySelector('h2').textContent = 'No clips in this range'
    emptyState.querySelector('p').textContent = 'Try an earlier starting date, remove the ending date, or show all clips.'
    emptyState.classList.remove('hidden')
  } else if (visibleSegments.length === 0) {
    emptyState.querySelector('h2').textContent = state.processingView === 'processed'
      ? 'No processed segments'
      : 'Everything here is processed'
    emptyState.querySelector('p').textContent = state.processingView === 'processed'
      ? 'Mark a segment or individual clip as processed and it will appear here.'
      : 'Switch to Processed or All to review these driving segments.'
    emptyState.classList.remove('hidden')
  } else {
    emptyState.classList.add('hidden')
    for (const segment of visibleSegments) {
      segmentsList.append(renderSegment(segment))
    }

    loadThumbnails(state.scanVersion, visibleSegments)
  }

  const totals = state.totals || { visible: 0, front: 0, rear: 0 }
  const segmentWord = state.segments.length === 1 ? 'segment' : 'segments'
  const processedSegments = state.segments.filter((segment) => segment.processed).length
  resultsSummary.textContent = `${totals.visible} of ${totals.front} front clips · ${totals.rear} rear clips · ${state.segments.length} ${segmentWord} · ${processedSegments} processed`
}

function setLoading() {
  emptyState.classList.add('hidden')
  resultsHeading.classList.add('hidden')
  segmentsList.replaceChildren()
  loadingState.classList.remove('hidden')
}

async function scan(showLoading = true) {
  if (!state.rootPath) {
    return
  }

  const filters = getFilters()

  if (filters.mode === 'range' && !filters.startDate) {
    return
  }

  const version = ++state.scanVersion

  if (showLoading) {
    setLoading()
  }

  try {
    const result = await window.dashcam.scanSource(state.rootPath, filters)

    if (version !== state.scanVersion) {
      return
    }

    state.segments = result.segments
    state.totals = result.totals
    renderResults()
  } catch (error) {
    if (version === state.scanVersion) {
      loadingState.classList.add('hidden')
      renderResults()
      showError(error)
    }
  }
}

async function chooseSource() {
  try {
    const selectedPath = await window.dashcam.chooseSource()

    if (!selectedPath) {
      return
    }

    if (selectedPath !== state.rootPath) {
      state.expandedSegments.clear()
      state.processingView = 'all'
    }

    state.rootPath = selectedPath
    sourcePath.textContent = selectedPath
    sourcePath.classList.remove('empty')
    scanButton.disabled = false
    await scan()
  } catch (error) {
    showError(error)
  }
}

async function playSegment(segment) {
  try {
    await window.dashcam.playSegment(segment.id)
  } catch (error) {
    showError(error)
  }
}

function askForName(segment) {
  return new Promise((resolve) => {
    const prefix = formatFilenamePrefix(segment.start)
    clipName.value = ''
    filenamePreview.textContent = `${prefix} ….mp4`

    const updatePreview = () => {
      const name = cleanPreviewName(clipName.value)
      filenamePreview.textContent = `${prefix}${name ? ` ${name}` : ' …'}.mp4`
    }

    const finish = (value) => {
      nameForm.removeEventListener('submit', submit)
      document.querySelector('#name-cancel').removeEventListener('click', cancel)
      document.querySelector('#name-close').removeEventListener('click', cancel)
      clipName.removeEventListener('input', updatePreview)
      nameDialog.removeEventListener('cancel', cancelDialog)
      nameDialog.close()
      resolve(value)
    }

    const submit = (event) => {
      event.preventDefault()
      const name = clipName.value.trim()
      if (name) {
        finish(name)
      }
    }

    const cancel = () => finish(null)
    const cancelDialog = (event) => {
      event.preventDefault()
      finish(null)
    }

    nameForm.addEventListener('submit', submit)
    document.querySelector('#name-cancel').addEventListener('click', cancel)
    document.querySelector('#name-close').addEventListener('click', cancel)
    clipName.addEventListener('input', updatePreview)
    nameDialog.addEventListener('cancel', cancelDialog)
    nameDialog.showModal()
    clipName.focus()
  })
}

function openProgress(title) {
  progressTitle.textContent = title
  progressPhase.textContent = 'Preparing FFmpeg…'
  progressBar.style.width = '0%'
  progressPercent.textContent = '0%'
  progressTrack.setAttribute('aria-valuenow', '0')
  cancelJobButton.disabled = false
  cancelJobButton.textContent = 'Cancel'

  if (!progressDialog.open) {
    progressDialog.showModal()
  }
}

function closeProgress() {
  if (progressDialog.open) {
    progressDialog.close()
  }
}

async function beginMerge(segment) {
  const name = await askForName(segment)

  if (!name) {
    return
  }

  openProgress('Combining front and rear clips')

  try {
    const output = await window.dashcam.mergeSegment(segment.id, name)
    closeProgress()
    openTrim(output, segment.durationMs / 1000)
  } catch (error) {
    closeProgress()
    showError(error)
  }
}

function updateTrimLabels() {
  if (!state.trim) {
    return
  }

  if (document.activeElement !== startOutput) {
    startOutput.value = formatVideoTime(Number(startRange.value))
  }

  if (document.activeElement !== endOutput) {
    endOutput.value = formatVideoTime(Number(endRange.value))
  }
  currentTime.textContent = `${formatVideoTime(trimVideo.currentTime || 0)} / ${formatVideoTime(state.trim.duration)}`
}

function setTrimDuration(duration) {
  if (!state.trim || !Number.isFinite(duration) || duration <= 0) {
    return
  }

  state.trim.duration = duration
  startRange.max = String(duration)
  endRange.max = String(duration)
  startRange.value = '0'
  endRange.value = String(duration)
  updateTrimLabels()
}

function openTrim(output, fallbackDuration) {
  state.trim = {
    ...output,
    duration: fallbackDuration,
    stopAtEnd: false
  }
  trimName.textContent = output.name
  videoFallback.classList.add('hidden')
  trimVideo.src = output.videoUrl
  trimVideo.load()
  setTrimDuration(fallbackDuration)
  trimDialog.showModal()
}

async function discardOutput() {
  if (!state.trim) {
    return
  }

  if (!window.confirm('Discard the temporary merged video? The original clips will stay untouched.')) {
    return
  }

  try {
    await window.dashcam.discardOutput(state.trim.outputId)
    trimVideo.pause()
    trimVideo.removeAttribute('src')
    trimVideo.load()
    state.trim = null
    trimDialog.close()
  } catch (error) {
    showError(error)
  }
}

async function saveOutput() {
  if (!state.trim) {
    return
  }

  const start = Number(startRange.value)
  const end = Number(endRange.value)

  if (end <= start) {
    showError(new Error('The ending point must be after the starting point.'))
    return
  }

  trimVideo.pause()
  trimDialog.close()
  openProgress('Saving trimmed clip')

  try {
    const destinationPath = await window.dashcam.saveTrimmedVideo({
      outputId: state.trim.outputId,
      start,
      end
    })
    closeProgress()
    trimVideo.removeAttribute('src')
    trimVideo.load()
    state.trim = null
    showToast(`Saved to ${destinationPath}`)
  } catch (error) {
    closeProgress()
    trimDialog.showModal()
    showError(error)
  }
}

async function deleteSegment(segment) {
  try {
    const response = await window.dashcam.deleteSegment(segment.id)

    if (response.deleted && response.result) {
      state.expandedSegments.delete(segment.id)
      state.segments = response.result.segments
      state.totals = response.result.totals
      renderResults()
      showToast('The segment was moved to the Recycle Bin or Trash.')
    }
  } catch (error) {
    await scan(false)
    showError(error)
  }
}

async function setProcessingState(segment, scope, processed, clipKey, button) {
  button.disabled = true
  const previousLabel = button.textContent
  button.textContent = 'Saving…'

  try {
    const updatedSegment = await window.dashcam.setProcessingState({
      segmentId: segment.id,
      scope,
      clipKey,
      processed
    })
    const index = state.segments.findIndex((item) => item.id === updatedSegment.id)

    if (index !== -1) {
      state.segments[index] = updatedSegment
    }

    if (state.totals) {
      state.totals.processedVisible = state.segments.reduce((total, item) => total + item.processedCount, 0)
    }

    renderResults()
    showToast(processed ? 'Processing state saved.' : 'Marked as unprocessed.')
  } catch (error) {
    button.disabled = false
    button.textContent = previousLabel
    showError(error)
  }
}

function renderToolStatus(tool, status) {
  const statusElement = document.querySelector(`#${tool}-status`)
  const statusText = statusElement.querySelector('span')
  const pathElement = document.querySelector(`#${tool}-path`)
  const clearButton = document.querySelector(`#clear-${tool}`)
  const chooseButton = document.querySelector(`#choose-${tool}`)

  statusElement.classList.toggle('available', status.available)
  statusElement.classList.toggle('unavailable', !status.available)
  statusText.textContent = status.available
    ? (status.selected ? 'Selected' : 'Detected automatically')
    : 'Not found'
  pathElement.textContent = status.path || `Choose the ${tool === 'ffmpeg' ? 'FFmpeg' : 'VLC'} executable`
  pathElement.title = status.path || ''
  clearButton.classList.toggle('hidden', !status.selected)
  chooseButton.textContent = status.selected ? 'Change' : 'Choose'
}

function renderToolSettings(status) {
  state.tools = status
  renderToolStatus('ffmpeg', status.ffmpeg)
  renderToolStatus('vlc', status.vlc)
}

async function refreshToolSettings() {
  try {
    renderToolSettings(await window.dashcam.getToolStatus())
  } catch (error) {
    showError(error)
  }
}

async function chooseExternalTool(tool) {
  try {
    renderToolSettings(await window.dashcam.chooseTool(tool))

    if (tool === 'ffmpeg' && state.rootPath) {
      renderResults()
    }
  } catch (error) {
    showError(error)
  }
}

async function clearExternalTool(tool) {
  try {
    renderToolSettings(await window.dashcam.clearTool(tool))

    if (tool === 'ffmpeg' && state.rootPath) {
      renderResults()
    }
  } catch (error) {
    showError(error)
  }
}

browseButton.addEventListener('click', chooseSource)
scanButton.addEventListener('click', () => scan())
for (const tab of document.querySelectorAll('.processing-tab')) {
  tab.addEventListener('click', () => {
    state.processingView = tab.dataset.processingView
    renderResults()
  })
}
toolsButton.addEventListener('click', async () => {
  await refreshToolSettings()
  toolsDialog.showModal()
})
document.querySelector('#tools-close').addEventListener('click', () => toolsDialog.close())
document.querySelector('#tools-done').addEventListener('click', () => toolsDialog.close())
document.querySelector('#choose-ffmpeg').addEventListener('click', () => chooseExternalTool('ffmpeg'))
document.querySelector('#choose-vlc').addEventListener('click', () => chooseExternalTool('vlc'))
document.querySelector('#clear-ffmpeg').addEventListener('click', () => clearExternalTool('ffmpeg'))
document.querySelector('#clear-vlc').addEventListener('click', () => clearExternalTool('vlc'))
toolsDialog.addEventListener('cancel', (event) => {
  event.preventDefault()
  toolsDialog.close()
})

for (const input of document.querySelectorAll('input[name="filter-mode"]')) {
  input.addEventListener('change', () => {
    updateFilterControls()
    scan()
  })
}

for (const input of [startDate, startTime, endDate, endTime]) {
  input.addEventListener('change', () => {
    updateFilterControls()
    scan()
  })
}

cancelJobButton.addEventListener('click', async () => {
  cancelJobButton.disabled = true
  cancelJobButton.textContent = 'Cancelling…'
  await window.dashcam.cancelMediaJob()
})

progressDialog.addEventListener('cancel', (event) => {
  event.preventDefault()
})

trimDialog.addEventListener('cancel', (event) => {
  event.preventDefault()
})

window.dashcam.onMediaProgress((progress) => {
  const percent = Math.max(0, Math.min(100, progress.percent || 0))
  progressPhase.textContent = progress.phase
  progressBar.style.width = `${percent}%`
  progressPercent.textContent = `${percent}%`
  progressTrack.setAttribute('aria-valuenow', String(percent))
})

trimVideo.addEventListener('loadedmetadata', () => {
  if (Number.isFinite(trimVideo.duration)) {
    setTrimDuration(trimVideo.duration)
  }
})

trimVideo.addEventListener('error', () => {
  videoFallback.classList.remove('hidden')
})

trimVideo.addEventListener('timeupdate', () => {
  if (!state.trim) {
    return
  }

  if (state.trim.stopAtEnd && trimVideo.currentTime >= Number(endRange.value)) {
    trimVideo.pause()
    state.trim.stopAtEnd = false
  }

  updateTrimLabels()
})

startRange.addEventListener('input', () => {
  const maximumStart = Math.max(0, Number(endRange.value) - 0.1)
  startRange.value = String(Math.min(Number(startRange.value), maximumStart))
  trimVideo.currentTime = Number(startRange.value)
  updateTrimLabels()
})

startOutput.addEventListener('change', () => {
  const parsedTime = parseVideoTime(startOutput.value)
  const maximumStart = Math.max(0, Number(endRange.value) - 0.1)

  if (parsedTime === null) {
    updateTrimLabels()
    showError(new Error('Enter the start as seconds, MM:SS, or HH:MM:SS.'))
    return
  }

  startRange.value = String(Math.min(parsedTime, maximumStart))
  trimVideo.currentTime = Number(startRange.value)
  updateTrimLabels()
})

endRange.addEventListener('input', () => {
  const minimumEnd = Math.min(state.trim?.duration || 0, Number(startRange.value) + 0.1)
  endRange.value = String(Math.max(Number(endRange.value), minimumEnd))
  trimVideo.currentTime = Number(endRange.value)
  updateTrimLabels()
})

endOutput.addEventListener('change', () => {
  const parsedTime = parseVideoTime(endOutput.value)
  const minimumEnd = Math.min(state.trim?.duration || 0, Number(startRange.value) + 0.1)

  if (parsedTime === null) {
    updateTrimLabels()
    showError(new Error('Enter the end as seconds, MM:SS, or HH:MM:SS.'))
    return
  }

  endRange.value = String(Math.min(state.trim.duration, Math.max(parsedTime, minimumEnd)))
  trimVideo.currentTime = Number(endRange.value)
  updateTrimLabels()
})

document.querySelector('#set-start').addEventListener('click', () => {
  startRange.value = String(Math.min(trimVideo.currentTime, Number(endRange.value) - 0.1))
  updateTrimLabels()
})

document.querySelector('#set-end').addEventListener('click', () => {
  endRange.value = String(Math.max(trimVideo.currentTime, Number(startRange.value) + 0.1))
  updateTrimLabels()
})

document.querySelector('#play-selection').addEventListener('click', async () => {
  if (!state.trim) {
    return
  }

  trimVideo.currentTime = Number(startRange.value)
  state.trim.stopAtEnd = true

  try {
    await trimVideo.play()
  } catch {
    videoFallback.classList.remove('hidden')
  }
})

document.querySelector('#open-output-vlc').addEventListener('click', async () => {
  try {
    await window.dashcam.openOutputInVlc(state.trim.outputId)
  } catch (error) {
    showError(error)
  }
})

document.querySelector('#discard-output').addEventListener('click', discardOutput)
document.querySelector('#discard-output-secondary').addEventListener('click', discardOutput)
document.querySelector('#save-output').addEventListener('click', saveOutput)
document.querySelector('#error-close').addEventListener('click', () => errorDialog.close())

updateFilterControls()
renderResults()
refreshToolSettings()
