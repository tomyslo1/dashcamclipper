const path = require('node:path')
const { pathToFileURL } = require('node:url')

const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  shell
} = require('electron')

const {
  findCameraFolders,
  scanSource,
  toPublicSegment
} = require('./lib/clips')

const {
  cleanupTemporaryFiles,
  discardTemporaryVideo,
  findFfmpeg,
  findVlc,
  generateSegmentThumbnail,
  mergeSegment,
  playFileInVlc,
  playSegmentInVlc,
  saveTrimmedVideo,
  setToolOverrides,
  validateToolExecutable
} = require('./lib/media')

const {
  readToolSettings,
  writeToolSettings
} = require('./lib/tool-settings')

let mainWindow = null
let activeProcess = null
let currentRootPath = null
let currentFilters = { mode: 'all' }
let toolSettings = {
  ffmpegPath: '',
  vlcPath: ''
}
const segmentsById = new Map()
const temporaryOutputs = new Map()

function createWindow() {
  nativeTheme.themeSource = 'system'

  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 820,
    minHeight: 620,
    title: 'Dashcam Clipper',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#171916' : '#f4f5ef',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.loadFile(path.join(__dirname, 'index.html'))
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
}

async function updateScan(rootPath, filters) {
  const result = await scanSource(rootPath, filters)
  segmentsById.clear()

  for (const segment of result.segments) {
    segmentsById.set(segment.id, segment)
  }

  currentRootPath = rootPath
  currentFilters = filters

  return {
    rootPath: result.rootPath,
    segments: result.segments.map(toPublicSegment),
    totals: result.totals
  }
}

function registerHandlers() {
  ipcMain.handle('get-tool-status', () => getToolStatus())

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

  ipcMain.handle('merge-segment', async (_event, segmentId, name) => {
    if (activeProcess) {
      throw new Error('Another media job is already running.')
    }

    const segment = getSegment(segmentId)
    const outputPath = await mergeSegment(segment.clips, sendProgress, setActiveProcess)
    const outputId = require('node:crypto').randomUUID()

    temporaryOutputs.set(outputId, {
      path: outputPath,
      segmentId,
      name
    })

    return {
      outputId,
      videoUrl: pathToFileURL(outputPath).href,
      name,
      segmentStart: segment.start.toISOString()
    }
  })

  ipcMain.handle('cancel-media-job', () => {
    if (activeProcess) {
      activeProcess.kill()
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

    const segment = getSegment(output.segmentId)
    const destinationPath = await saveTrimmedVideo({
      sourcePath: output.path,
      segmentStart: segment.start,
      name: output.name,
      start: options.start,
      end: options.end
    }, sendProgress, setActiveProcess)

    temporaryOutputs.delete(options.outputId)
    return destinationPath
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
      message: `Delete the clips from ${start} – ${end}?`,
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
}

app.setName('Dashcam Clipper')

app.whenReady().then(async () => {
  toolSettings = await readToolSettings(app.getPath('userData'))
  setToolOverrides(toolSettings)
  await cleanupTemporaryFiles().catch(() => {})
  registerHandlers()
  createWindow()

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
