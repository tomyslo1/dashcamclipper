const fs = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  shell
} = require('electron')

const {
  createClipRange,
  findCameraFolders,
  findOriginalClips,
  refreshSegmentProcessing,
  scanSource,
  sortClipsByName,
  toPublicSegment
} = require('./lib/clips')

const {
  applyFilenameDateOverrides,
  applyFilenameDateToVideo,
  buildProcessedFilename,
  cleanupTemporaryFiles,
  dateFromProcessedVideoFilename,
  discardTemporaryVideo,
  findFfmpeg,
  findVlc,
  generateProcessedVideoThumbnail,
  generateSegmentThumbnail,
  getProcessedNameSuggestions,
  listProcessedVideos,
  mergeSegment,
  parseProcessedVideoFilename,
  playFileInVlc,
  playProcessedVideo,
  playSegmentInVlc,
  processedVideoPath,
  saveTrimmedVideo,
  setToolOverrides,
  validateToolExecutable
} = require('./lib/media')

const {
  readToolSettings,
  writeToolSettings
} = require('./lib/tool-settings')

const {
  readLibrarySettings,
  writeLibrarySettings
} = require('./lib/library-settings')

const { copyImportPlan } = require('./lib/import-clips')
const { ejectSource } = require('./lib/eject-source')

const {
  readProcessingMetadata,
  setClipsProcessed
} = require('./lib/processing-metadata')

const { buildUpdateStatus, isReleaseUrl } = require('./lib/update-check')

let mainWindow = null
let activeProcess = null
let currentRootPath = null
let currentFilters = { mode: 'all' }
let metadataWriteQueue = Promise.resolve()
let currentImportPlan = []
let currentLibraryFolders = null
let importInProgress = false
let importCancelled = false
let toolSettings = {
  ffmpegPath: '',
  vlcPath: '',
  theme: 'auto',
  mirrorRear: true,
  segmentGapMinutes: 3,
  checkForUpdates: true,
  thumbnailPreviews: true,
  ejectAfterImport: true
}
let librarySettings = {
  libraryPath: ''
}
const segmentsById = new Map()
const temporaryOutputs = new Map()
let updateStatus = {
  available: false,
  currentVersion: '',
  latestVersion: '',
  releaseUrl: ''
}

async function checkForUpdates() {
  const currentVersion = app.getVersion()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)

  try {
    const response = await net.fetch('https://api.github.com/repos/tomyslo1/dashcamclipper/releases/latest', {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `Dashcam-Clipper/${currentVersion}`,
        'X-GitHub-Api-Version': '2026-03-10'
      },
      signal: controller.signal
    })

    if (!response.ok) {
      return updateStatus
    }

    if (!toolSettings.checkForUpdates) {
      return updateStatus
    }

    updateStatus = buildUpdateStatus(currentVersion, await response.json())
    mainWindow?.webContents.send('update-status', updateStatus)
  } catch {
    updateStatus = {
      available: false,
      currentVersion,
      latestVersion: '',
      releaseUrl: ''
    }
  } finally {
    clearTimeout(timeout)
  }

  return updateStatus
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 820,
    minHeight: 620,
    title: 'Dashcam Clipper',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#171916' : '#f4f5ef',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.loadFile(path.join(__dirname, 'index.html'))
  mainWindow.webContents.once('did-finish-load', () => {
    mainWindow.webContents.send('update-status', updateStatus)
  })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
  }
}

function getSegment(segmentId) {
  const segment = segmentsById.get(segmentId)

  if (!segment) {
    throw new Error('This segment is no longer available. Scan the folder again.')
  }

  return segment
}

function getSegments(segmentIds) {
  if (!Array.isArray(segmentIds) || segmentIds.length === 0) {
    throw new Error('Select at least one driving segment.')
  }

  return [...new Set(segmentIds)]
    .map((segmentId) => getSegment(segmentId))
    .sort((left, right) => left.start - right.start)
}

function sendProgress(progress) {
  mainWindow?.webContents.send('media-progress', progress)
}

function setActiveProcess(child) {
  activeProcess = child
}

function getToolStatus() {
  const ffmpegPath = findFfmpeg()
  const vlcPath = findVlc()

  return {
    ffmpeg: {
      available: Boolean(ffmpegPath),
      path: toolSettings.ffmpegPath || ffmpegPath || '',
      selected: Boolean(toolSettings.ffmpegPath)
    },
    vlc: {
      available: Boolean(vlcPath),
      path: toolSettings.vlcPath || vlcPath || '',
      selected: Boolean(toolSettings.vlcPath)
    },
    preferences: {
      theme: toolSettings.theme,
      mirrorRear: toolSettings.mirrorRear,
      segmentGapMinutes: toolSettings.segmentGapMinutes,
      checkForUpdates: toolSettings.checkForUpdates,
      thumbnailPreviews: toolSettings.thumbnailPreviews,
      ejectAfterImport: toolSettings.ejectAfterImport
    }
  }
}

function normalizeToolPath(tool, selectedPath) {
  if (process.platform === 'darwin' && tool === 'vlc' && selectedPath.toLowerCase().endsWith('.app')) {
    return path.join(selectedPath, 'Contents', 'MacOS', 'VLC')
  }

  return selectedPath
}

async function saveCurrentToolSettings() {
  toolSettings = await writeToolSettings(app.getPath('userData'), toolSettings)
  setToolOverrides(toolSettings)
  nativeTheme.themeSource = toolSettings.theme === 'auto' ? 'system' : toolSettings.theme
}

async function saveCurrentLibrarySettings() {
  librarySettings = await writeLibrarySettings(app.getPath('userData'), librarySettings)
}

async function getLibraryStatus() {
  if (!librarySettings.libraryPath) {
    return { configured: false, available: false, path: '' }
  }

  try {
    await findCameraFolders(librarySettings.libraryPath)
    return { configured: true, available: true, path: librarySettings.libraryPath }
  } catch {
    return { configured: true, available: false, path: librarySettings.libraryPath }
  }
}

function queueMetadataWrite(operation) {
  const result = metadataWriteQueue.then(operation, operation)
  metadataWriteQueue = result.catch(() => {})
  return result
}

async function setClipKeysProcessingState(clipKeys, processed) {
  if (!librarySettings.libraryPath) {
    throw new Error('Choose the server library before changing processing state.')
  }

  const metadata = await setClipsProcessed(librarySettings.libraryPath, clipKeys, processed)
  const changedKeys = new Set(clipKeys)

  for (const currentSegment of segmentsById.values()) {
    for (const clip of currentSegment.clips) {
      if (changedKeys.has(clip.key)) {
        clip.processedAt = metadata.processedClips[clip.key] || null
        clip.processed = Boolean(clip.processedAt)
      }
    }

    refreshSegmentProcessing(currentSegment)
  }

  return metadata
}

async function updateProcessingState(options) {
  if (!currentRootPath) {
    throw new Error('Choose and scan a source folder first.')
  }

  if (!options || typeof options.processed !== 'boolean') {
    throw new Error('The requested processing state is invalid.')
  }

  let segment = null
  let affectedSegments = []
  let clipKeys

  if (options.scope === 'segment') {
    segment = getSegment(options.segmentId)
    affectedSegments = [segment]
    clipKeys = segment.clips.map((clip) => clip.key)
  } else if (options.scope === 'clip') {
    segment = getSegment(options.segmentId)
    affectedSegments = [segment]
    const clip = segment.clips.find((item) => item.key === options.clipKey)

    if (!clip) {
      throw new Error('This clip is no longer part of the selected segment.')
    }

    clipKeys = [clip.key]
  } else if (options.scope === 'segments') {
    affectedSegments = getSegments(options.segmentIds)
    clipKeys = affectedSegments.flatMap((item) => item.clips.map((clip) => clip.key))
  } else {
    throw new Error('Choose a segment or clip to update.')
  }

  await setClipKeysProcessingState(clipKeys, options.processed)

  if (options.scope === 'segments') {
    return affectedSegments.map(toPublicSegment)
  }

  return toPublicSegment(segment)
}

async function updateScan(rootPath, filters) {
  if (!librarySettings.libraryPath) {
    throw new Error('Choose the permanent server library before scanning a source.')
  }

  const result = await scanSource(
    rootPath,
    filters,
    librarySettings.libraryPath,
    toolSettings.segmentGapMinutes * 60 * 1000
  )
  segmentsById.clear()

  for (const segment of result.segments) {
    segmentsById.set(segment.id, segment)
  }

  currentRootPath = rootPath
  currentFilters = filters
  currentImportPlan = result.importPlan
  currentLibraryFolders = {
    frontPath: result.libraryFrontPath,
    rearPath: result.libraryRearPath
  }

  return {
    rootPath: result.rootPath,
    libraryPath: result.libraryRootPath,
    sourceIsLibrary: result.sourceIsLibrary,
    importStatus: {
      newFiles: result.importPlan.length,
      newFront: result.totals.newFront,
      newRear: result.totals.newRear,
      newBytes: result.totals.newBytes
    },
    segments: result.segments.map(toPublicSegment),
    totals: result.totals
  }
}

async function importNewClips() {
  if (activeProcess || importInProgress) {
    throw new Error('Another media or import job is already running.')
  }

  if (!currentRootPath || !currentLibraryFolders) {
    throw new Error('Scan a microSD card source before importing clips.')
  }

  if (currentImportPlan.length === 0) {
    const sourcePath = currentRootPath
    const result = await updateScan(librarySettings.libraryPath, currentFilters)
    const eject = toolSettings.ejectAfterImport
      ? await ejectSource(sourcePath, librarySettings.libraryPath)
      : { requested: false, attempted: false, ejected: false, message: '' }

    return {
      copied: 0,
      skipped: 0,
      result,
      eject
    }
  }

  importInProgress = true
  importCancelled = false
  const plan = [...currentImportPlan]
  const sourcePath = currentRootPath

  try {
    sendProgress({ phase: `Importing 0 of ${plan.length} new files`, percent: 0 })
    const copyResult = await copyImportPlan(
      plan,
      currentLibraryFolders,
      (progress) => sendProgress({
        phase: `Importing ${progress.current} of ${progress.total} new files`,
        percent: progress.percent
      }),
      () => importCancelled
    )
    sendProgress({ phase: 'Opening the server library', percent: 100 })
    const result = await updateScan(librarySettings.libraryPath, currentFilters)
    let eject = { requested: false, attempted: false, ejected: false, message: '' }

    if (toolSettings.ejectAfterImport) {
      sendProgress({ phase: 'Ejecting the microSD card', percent: 100 })
      eject = await ejectSource(sourcePath, librarySettings.libraryPath)
    }

    return { ...copyResult, result, eject }
  } finally {
    importInProgress = false
    importCancelled = false
  }
}

async function mergeSelectedSegments(segmentIds, options) {
  if (activeProcess) {
    throw new Error('Another media job is already running.')
  }

  const segments = getSegments(segmentIds)
  const clips = sortClipsByName(segments.flatMap((segment) => segment.clips))
  const name = typeof options?.name === 'string' ? options.name.trim() : ''

  if (!name) {
    throw new Error('Enter a name for the clip.')
  }

  const filenameClip = clips[Math.min(1, clips.length - 1)]
  const filenameDate = applyFilenameDateOverrides(
    filenameClip.recordedAt,
    options.dateOverride,
    options.timeOverride
  )
  const clipRange = createClipRange(clips)

  const outputPath = await mergeSegment(
    clips,
    { mirrorRear: options.mirrorRear !== false },
    sendProgress,
    setActiveProcess
  )
  const outputId = require('node:crypto').randomUUID()

  temporaryOutputs.set(outputId, {
    path: outputPath,
    name,
    filenameDate,
    clipRange,
    clipKeys: [...new Set(clips.map((clip) => clip.key))]
  })

  return {
    outputId,
    videoUrl: pathToFileURL(outputPath).href,
    name,
    filenameDate: filenameDate.toISOString(),
    clipRange,
    durationMs: clips.length * 60 * 1000
  }
}

async function reencodeSavedVideo(fileName) {
  if (activeProcess || importInProgress) {
    throw new Error('Wait for the current media or import job to finish before rebuilding a saved video.')
  }

  if (!librarySettings.libraryPath) {
    throw new Error('Choose the permanent server library before rebuilding a saved video.')
  }

  const savedPath = processedVideoPath(fileName)
  const parsed = parseProcessedVideoFilename(fileName)

  if (!parsed?.clipRange) {
    throw new Error('The saved filename needs an original clip number or range in parentheses.')
  }

  const filenameDate = dateFromProcessedVideoFilename(fileName)
  const normalizedName = buildProcessedFilename(filenameDate, parsed.title, parsed.clipRange)

  if (normalizedName !== fileName) {
    throw new Error('The saved filename must use the standard Dashcam Clipper format before it can be rebuilt.')
  }

  await fs.access(savedPath)
  sendProgress({ phase: 'Finding the original camera clips', percent: 0 })
  const clips = await findOriginalClips(librarySettings.libraryPath, parsed.clipRange)
  const outputPath = await mergeSegment(
    clips,
    { mirrorRear: toolSettings.mirrorRear !== false },
    sendProgress,
    setActiveProcess
  )
  const outputId = require('node:crypto').randomUUID()

  temporaryOutputs.set(outputId, {
    path: outputPath,
    name: parsed.title,
    filenameDate,
    clipRange: parsed.clipRange,
    clipKeys: [...new Set(clips.map((clip) => clip.key))],
    replaceFileName: fileName
  })

  return {
    outputId,
    videoUrl: pathToFileURL(outputPath).href,
    name: parsed.title,
    filenameDate: filenameDate.toISOString(),
    clipRange: parsed.clipRange,
    durationMs: clips.length * 60 * 1000,
    replacesExisting: true
  }
}

async function deleteSelectedSegments(segmentIds) {
  if (activeProcess || importInProgress) {
    throw new Error('Wait for the current media or import job to finish before deleting clips.')
  }

  const segments = getSegments(segmentIds)
  const clips = segments.flatMap((segment) => segment.clips)
  const first = segments[0]
  const last = segments[segments.length - 1]
  const start = first.start.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
  const end = last.end.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
  const segmentWord = segments.length === 1 ? 'segment' : 'segments'
  const firstConfirmation = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: `Delete ${segments.length} driving ${segmentWord}?`,
    message: `Delete the selected clips from ${start} to ${end}?`,
    detail: `${clips.length} front clips and ${clips.filter((clip) => clip.rear).length} rear clips will be removed from the source.`,
    buttons: ['Continue', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  })

  if (firstConfirmation.response !== 0) {
    return { deleted: false }
  }

  const secondConfirmation = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Double-check deletion',
    message: `Are you sure you want to delete ${segments.length} selected ${segmentWord}?`,
    detail: 'Dashcam Clipper will move every selected front and rear clip to the Recycle Bin or Trash when the source supports it.',
    buttons: [`Delete ${segmentWord}`, 'Keep clips'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  })

  if (secondConfirmation.response !== 0) {
    return { deleted: false }
  }

  const filePaths = [...new Set(clips.flatMap((clip) => [clip.front.path, clip.rear?.path]).filter(Boolean))]
  const failures = []

  for (const filePath of filePaths) {
    try {
      await shell.trashItem(filePath)
    } catch (error) {
      failures.push({ filePath, message: error.message })
    }
  }

  if (failures.length > 0) {
    throw new Error(`${filePaths.length - failures.length} files were deleted, but ${failures.length} could not be removed. Scan again to see what remains.`)
  }

  return {
    deleted: true,
    result: currentRootPath ? await updateScan(currentRootPath, currentFilters) : null
  }
}

function registerHandlers() {
  ipcMain.handle('get-library-status', () => getLibraryStatus())

  ipcMain.handle('choose-library', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose the permanent server library',
      properties: ['openDirectory']
    })

    if (result.canceled || result.filePaths.length === 0) {
      return getLibraryStatus()
    }

    const selectedPath = result.filePaths[0]
    await findCameraFolders(selectedPath)
    await readProcessingMetadata(selectedPath)
    librarySettings.libraryPath = selectedPath
    await saveCurrentLibrarySettings()
    return getLibraryStatus()
  })

  ipcMain.handle('get-tool-status', () => getToolStatus())

  ipcMain.handle('save-preferences', async (_event, preferences) => {
    const checkedForUpdatesBefore = toolSettings.checkForUpdates
    toolSettings = {
      ...toolSettings,
      theme: preferences?.theme,
      mirrorRear: preferences?.mirrorRear,
      segmentGapMinutes: preferences?.segmentGapMinutes,
      checkForUpdates: preferences?.checkForUpdates,
      thumbnailPreviews: preferences?.thumbnailPreviews,
      ejectAfterImport: preferences?.ejectAfterImport
    }
    await saveCurrentToolSettings()

    if (!toolSettings.checkForUpdates) {
      updateStatus = {
        available: false,
        currentVersion: app.getVersion(),
        latestVersion: '',
        releaseUrl: ''
      }
      mainWindow?.webContents.send('update-status', updateStatus)
    } else if (!checkedForUpdatesBefore) {
      checkForUpdates()
    }

    return getToolStatus()
  })

  ipcMain.handle('choose-tool', async (_event, tool) => {
    if (!['ffmpeg', 'vlc'].includes(tool)) {
      throw new Error('Unknown external tool.')
    }

    const name = tool === 'ffmpeg' ? 'FFmpeg' : 'VLC'
    const dialogOptions = {
      title: `Choose the ${name} executable`,
      properties: ['openFile']
    }

    if (process.platform === 'win32') {
      dialogOptions.filters = [
        { name: 'Programs', extensions: ['exe'] },
        { name: 'All files', extensions: ['*'] }
      ]
    }

    const result = await dialog.showOpenDialog(mainWindow, dialogOptions)

    if (result.canceled || result.filePaths.length === 0) {
      return getToolStatus()
    }

    const selectedPath = normalizeToolPath(tool, result.filePaths[0])

    if (!validateToolExecutable(tool, selectedPath)) {
      throw new Error(`${name} could not be started from the selected file. Choose its executable and try again.`)
    }

    toolSettings[`${tool}Path`] = selectedPath
    await saveCurrentToolSettings()
    return getToolStatus()
  })

  ipcMain.handle('clear-tool', async (_event, tool) => {
    if (!['ffmpeg', 'vlc'].includes(tool)) {
      throw new Error('Unknown external tool.')
    }

    toolSettings[`${tool}Path`] = ''
    await saveCurrentToolSettings()
    return getToolStatus()
  })

  ipcMain.handle('choose-source', async () => {
    const libraryStatus = await getLibraryStatus()

    if (!libraryStatus.available) {
      throw new Error('Choose an available server library before selecting a source.')
    }

    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose the folder containing DCIMA and DCIMB',
      properties: ['openDirectory']
    })

    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    const selectedPath = result.filePaths[0]
    await findCameraFolders(selectedPath)
    return selectedPath
  })

  ipcMain.handle('scan-source', async (_event, rootPath, filters) => {
    if (!rootPath || typeof rootPath !== 'string') {
      throw new Error('Choose a source folder first.')
    }

    return updateScan(rootPath, filters)
  })

  ipcMain.handle('play-segment', async (_event, segmentId) => {
    const segment = getSegment(segmentId)
    await playSegmentInVlc(segment.clips)
  })

  ipcMain.handle('get-segment-thumbnail', async (_event, segmentId) => {
    const segment = getSegment(segmentId)
    return generateSegmentThumbnail(segment)
  })

  ipcMain.handle('set-processing-state', (_event, options) => {
    return queueMetadataWrite(() => updateProcessingState(options))
  })

  ipcMain.handle('import-new-clips', () => importNewClips())

  ipcMain.handle('get-name-suggestions', () => getProcessedNameSuggestions())

  ipcMain.handle('list-processed-videos', () => listProcessedVideos())

  ipcMain.handle('get-processed-video-thumbnail', (_event, fileName) => generateProcessedVideoThumbnail(fileName))

  ipcMain.handle('play-processed-video', (_event, fileName) => playProcessedVideo(fileName))

  ipcMain.handle('reencode-saved-video', (_event, fileName) => reencodeSavedVideo(fileName))

  ipcMain.handle('apply-title-dates-to-videos', async (_event, fileNames) => {
    if (activeProcess || importInProgress) {
      throw new Error('Wait for the current media or import job to finish before updating a video.')
    }

    if (!Array.isArray(fileNames) || fileNames.length === 0) {
      throw new Error('Select at least one saved video.')
    }

    const selectedNames = [...new Set(fileNames)]
    const updated = []
    const failures = []

    for (const [index, fileName] of selectedNames.entries()) {
      try {
        const filePath = processedVideoPath(fileName)
        const result = await applyFilenameDateToVideo(
          filePath,
          (progress) => sendProgress({
            phase: `${index + 1} of ${selectedNames.length}: ${fileName}`,
            percent: Math.round(((index + (progress.percent || 0) / 100) / selectedNames.length) * 100)
          }),
          setActiveProcess
        )
        updated.push(result.fileName)
      } catch (error) {
        if (/cancelled/i.test(error.message)) {
          return { updated, failures, cancelled: true }
        }

        failures.push({ fileName, message: error.message })
      }
    }

    return { updated, failures, cancelled: false }
  })

  ipcMain.handle('get-update-status', () => updateStatus)

  ipcMain.handle('open-update-release', async () => {
    if (!updateStatus.available || !isReleaseUrl(updateStatus.releaseUrl)) {
      return false
    }

    await shell.openExternal(updateStatus.releaseUrl)
    return true
  })

  ipcMain.handle('merge-segments', (_event, segmentIds, options) => mergeSelectedSegments(segmentIds, options))

  ipcMain.handle('cancel-media-job', () => {
    if (activeProcess) {
      activeProcess.kill()
      return true
    }

    if (importInProgress) {
      importCancelled = true
      return true
    }

    return false
  })

  ipcMain.handle('open-output-in-vlc', async (_event, outputId) => {
    const output = temporaryOutputs.get(outputId)

    if (!output) {
      throw new Error('The temporary video is no longer available.')
    }

    playFileInVlc(output.path)
  })

  ipcMain.handle('save-trimmed-video', async (_event, options) => {
    if (activeProcess) {
      throw new Error('Another media job is already running.')
    }

    const output = temporaryOutputs.get(options.outputId)

    if (!output) {
      throw new Error('The temporary video is no longer available.')
    }

    const destinationPath = await saveTrimmedVideo({
      sourcePath: output.path,
      filenameDate: output.filenameDate,
      clipRange: output.clipRange,
      name: output.name,
      start: options.start,
      end: options.end,
      replaceFileName: output.replaceFileName
    }, sendProgress, setActiveProcess)

    let processingWarning = ''

    try {
      await queueMetadataWrite(() => setClipKeysProcessingState(output.clipKeys, true))
    } catch (error) {
      processingWarning = `The video was saved, but its source clips could not be marked processed: ${error.message}`
    }

    temporaryOutputs.delete(options.outputId)
    return {
      destinationPath,
      segments: [...segmentsById.values()].map(toPublicSegment),
      processingWarning,
      replacedFileName: output.replaceFileName || ''
    }
  })

  ipcMain.handle('discard-output', async (_event, outputId) => {
    const output = temporaryOutputs.get(outputId)

    if (!output) {
      return
    }

    await discardTemporaryVideo(output.path)
    temporaryOutputs.delete(outputId)
  })

  ipcMain.handle('delete-segment', async (_event, segmentId) => {
    const segment = getSegment(segmentId)
    const start = segment.start.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
    const end = segment.end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    const firstConfirmation = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Delete driving segment?',
      message: `Delete the clips from ${start} - ${end}?`,
      detail: `${segment.clipCount} front clips and ${segment.pairedCount} rear clips will be removed from the source.`,
      buttons: ['Continue', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    })

    if (firstConfirmation.response !== 0) {
      return { deleted: false }
    }

    const secondConfirmation = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Double-check deletion',
      message: 'Are you sure you want to delete this entire segment?',
      detail: 'Dashcam Clipper will move every listed front and rear clip to the Recycle Bin or Trash when the source supports it.',
      buttons: ['Delete segment', 'Keep clips'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    })

    if (secondConfirmation.response !== 0) {
      return { deleted: false }
    }

    const filePaths = [...new Set(segment.clips.flatMap((clip) => [clip.front.path, clip.rear?.path]).filter(Boolean))]
    const failures = []

    for (const filePath of filePaths) {
      try {
        await shell.trashItem(filePath)
      } catch (error) {
        failures.push({ filePath, message: error.message })
      }
    }

    if (failures.length > 0) {
      throw new Error(`${filePaths.length - failures.length} files were deleted, but ${failures.length} could not be removed. Scan again to see what remains.`)
    }

    if (currentRootPath) {
      return {
        deleted: true,
        result: await updateScan(currentRootPath, currentFilters)
      }
    }

    return { deleted: true }
  })

  ipcMain.handle('delete-segments', (_event, segmentIds) => deleteSelectedSegments(segmentIds))
}

app.setName('Dashcam Clipper')

app.whenReady().then(async () => {
  toolSettings = await readToolSettings(app.getPath('userData'))
  librarySettings = await readLibrarySettings(app.getPath('userData'))
  nativeTheme.themeSource = toolSettings.theme === 'auto' ? 'system' : toolSettings.theme
  setToolOverrides(toolSettings)
  await cleanupTemporaryFiles().catch(() => {})
  registerHandlers()
  createWindow()

  if (toolSettings.checkForUpdates) {
    checkForUpdates()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
