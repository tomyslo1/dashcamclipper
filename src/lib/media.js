const { spawn, spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fsSync = require('node:fs')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

let toolOverrides = {
  ffmpegPath: '',
  vlcPath: ''
}

function setToolOverrides(settings) {
  toolOverrides = {
    ffmpegPath: typeof settings?.ffmpegPath === 'string' ? settings.ffmpegPath : '',
    vlcPath: typeof settings?.vlcPath === 'string' ? settings.vlcPath : ''
  }
}

function canRun(command, args = ['-version']) {
  if (!command) {
    return false
  }

  try {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true
    })
    return !result.error && result.status === 0
  } catch {
    return false
  }
}

function findFfmpeg() {
  if (toolOverrides.ffmpegPath) {
    return canRun(toolOverrides.ffmpegPath) ? toolOverrides.ffmpegPath : null
  }

  const candidates = [
    process.env.DASHCAM_CLIPPER_FFMPEG,
    process.env.FFMPEG_PATH,
    'ffmpeg'
  ]

  return candidates.find((candidate) => canRun(candidate)) || null
}

function findVlc() {
  if (toolOverrides.vlcPath) {
    return isExecutableFile(toolOverrides.vlcPath) ? toolOverrides.vlcPath : null
  }

  const candidates = process.platform === 'win32'
    ? [
        process.env.DASHCAM_CLIPPER_VLC,
        'vlc',
        'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe',
        'C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe'
      ]
    : [
        process.env.DASHCAM_CLIPPER_VLC,
        'vlc',
        '/Applications/VLC.app/Contents/MacOS/VLC'
      ]

  return candidates.find((candidate) => {
    if (!candidate) {
      return false
    }

    if (path.isAbsolute(candidate)) {
      return isExecutableFile(candidate)
    }

    const locator = process.platform === 'win32' ? 'where.exe' : 'which'
    const result = spawnSync(locator, [candidate], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true
    })
    return !result.error && result.status === 0
  }) || null
}

function isExecutableFile(filePath) {
  if (!filePath) {
    return false
  }

  try {
    return fsSync.statSync(filePath).isFile()
  } catch {
    return false
  }
}

function validateToolExecutable(tool, filePath) {
  if (tool === 'ffmpeg') {
    return canRun(filePath)
  }

  if (tool === 'vlc') {
    return isExecutableFile(filePath)
  }

  return false
}

async function getTempFolder() {
  const folder = path.join(os.tmpdir(), 'dashcam-clipper')
  await fs.mkdir(folder, { recursive: true })
  return folder
}

async function cleanupTemporaryFiles() {
  const folder = await getTempFolder()
  const entries = await fs.readdir(folder, { withFileTypes: true })

  for (const entry of entries) {
    const isOwnedFile = entry.isFile() && (
      (entry.name.startsWith('merged-') && entry.name.endsWith('.mp4')) ||
      (entry.name.startsWith('segment-') && entry.name.endsWith('.m3u8')) ||
      (entry.name.startsWith('thumbnail-') && entry.name.endsWith('.jpg'))
    )

    if (isOwnedFile) {
      await fs.rm(path.join(folder, entry.name), { force: true })
    }
  }
}

function buildThumbnailArguments(inputPath, outputPath) {
  return [
    '-y',
    '-ss',
    '0.25',
    '-i',
    inputPath,
    '-frames:v',
    '1',
    '-vf',
    'scale=320:-2',
    '-q:v',
    '4',
    outputPath
  ]
}

async function generateSegmentThumbnail(segment) {
  const ffmpeg = findFfmpeg()

  if (!ffmpeg || !segment?.clips?.[0]?.front?.path) {
    return null
  }

  const tempFolder = await getTempFolder()
  const outputPath = path.join(tempFolder, `thumbnail-${segment.id}.jpg`)

  const existingImage = await fs.readFile(outputPath).catch(() => null)

  if (existingImage?.length > 0) {
    return `data:image/jpeg;base64,${existingImage.toString('base64')}`
  }

  try {
    const args = buildThumbnailArguments(segment.clips[0].front.path, outputPath)

    await new Promise((resolve, reject) => {
      const child = spawn(ffmpeg, args, { windowsHide: true, stdio: 'ignore' })
      const timeout = setTimeout(() => {
        child.kill()
        reject(new Error('Thumbnail generation timed out.'))
      }, 15000)

      child.on('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })

      child.on('close', (code) => {
        clearTimeout(timeout)

        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`FFmpeg stopped with code ${code}.`))
        }
      })
    })

    const image = await fs.readFile(outputPath)
    return `data:image/jpeg;base64,${image.toString('base64')}`
  } catch {
    await fs.rm(outputPath, { force: true })
    return null
  }
}

async function createVlcPlaylist(clips) {
  const tempFolder = await getTempFolder()
  const playlistPath = path.join(tempFolder, `segment-${crypto.randomUUID()}.m3u8`)
  const lines = ['#EXTM3U', ...clips.map((clip) => clip.front.path)]
  await fs.writeFile(playlistPath, lines.join(os.EOL), 'utf8')
  return playlistPath
}

function launchDetached(command, args) {
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  })
  child.unref()
}

async function playSegmentInVlc(clips) {
  const vlc = findVlc()

  if (!vlc) {
    throw new Error('VLC was not found. Install VLC or set DASHCAM_CLIPPER_VLC to the VLC executable.')
  }

  const playlistPath = await createVlcPlaylist(clips)
  launchDetached(vlc, ['--play-and-exit', playlistPath])
}

function playFileInVlc(filePath) {
  const vlc = findVlc()

  if (!vlc) {
    throw new Error('VLC was not found. Install VLC or set DASHCAM_CLIPPER_VLC to the VLC executable.')
  }

  launchDetached(vlc, [filePath])
}

function findEncoder(ffmpeg) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-encoders'], {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true
  })
  const encoders = `${result.stdout || ''}\n${result.stderr || ''}`

  if (process.platform === 'win32' && encoders.includes('hevc_nvenc') && canEncode(ffmpeg, 'hevc_nvenc')) {
    return {
      name: 'NVIDIA HEVC',
      args: ['-c:v', 'hevc_nvenc', '-preset', 'p7', '-rc', 'vbr', '-cq', '32', '-b:v', '0', '-spatial-aq', '1']
    }
  }

  if (process.platform === 'darwin' && encoders.includes('hevc_videotoolbox') && canEncode(ffmpeg, 'hevc_videotoolbox')) {
    return {
      name: 'Apple VideoToolbox HEVC',
      args: ['-c:v', 'hevc_videotoolbox', '-q:v', '65', '-tag:v', 'hvc1']
    }
  }

  if (encoders.includes('libx265')) {
    return {
      name: 'software HEVC',
      args: ['-c:v', 'libx265', '-preset', 'medium', '-crf', '30', '-tag:v', 'hvc1']
    }
  }

  if (encoders.includes('libx264')) {
    return {
      name: 'software H.264',
      args: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '23']
    }
  }

  throw new Error('This FFmpeg installation does not contain a supported H.264 or HEVC encoder.')
}

function canEncode(ffmpeg, encoder) {
  const result = spawnSync(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=size=256x256:rate=1',
    '-frames:v',
    '1',
    '-an',
    '-c:v',
    encoder,
    '-f',
    'null',
    '-'
  ], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true
  })

  return !result.error && result.status === 0
}

function buildMergeArguments(clips, outputPath, encoderArgs) {
  const inputArgs = []
  const stackedVideos = []
  const concatInputs = []

  clips.forEach((clip, index) => {
    inputArgs.push('-i', clip.front.path, '-i', clip.rear.path)
    stackedVideos.push(`[${index * 2}:v][${index * 2 + 1}:v]vstack=inputs=2[v${index}]`)
    concatInputs.push(`[v${index}][${index * 2}:a]`)
  })

  const filter = `${stackedVideos.join(';')};${concatInputs.join('')}concat=n=${clips.length}:v=1:a=1[outv][outa]`

  return [
    '-y',
    ...inputArgs,
    '-filter_complex',
    filter,
    '-map',
    '[outv]',
    '-map',
    '[outa]',
    ...encoderArgs,
    '-c:a',
    'aac',
    '-b:a',
    '64k',
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:1',
    '-nostats',
    outputPath
  ]
}

function parseProgressLine(line, expectedDurationSeconds) {
  if (!line.startsWith('out_time_ms=')) {
    return null
  }

  const microseconds = Number(line.slice('out_time_ms='.length))

  if (!Number.isFinite(microseconds) || expectedDurationSeconds <= 0) {
    return null
  }

  return Math.min(99, Math.max(0, Math.round((microseconds / 1000000 / expectedDurationSeconds) * 100)))
}

function runFfmpeg(ffmpeg, args, expectedDurationSeconds, onProgress, onProcess) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true })
    let stdoutBuffer = ''
    let stderr = ''

    onProcess(child)

    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString()
      const lines = stdoutBuffer.split(/\r?\n/)
      stdoutBuffer = lines.pop() || ''

      for (const line of lines) {
        const percent = parseProgressLine(line, expectedDurationSeconds)
        if (percent !== null) {
          onProgress(percent)
        }
      }
    })

    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-12000)
    })

    child.on('error', (error) => {
      reject(error)
    })

    child.on('close', (code, signal) => {
      onProcess(null)

      if (code === 0) {
        onProgress(100)
        resolve()
        return
      }

      if (signal) {
        reject(new Error('The media job was cancelled.'))
        return
      }

      const detail = stderr.trim().split(/\r?\n/).slice(-8).join('\n')
      reject(new Error(`FFmpeg stopped with code ${code}.${detail ? `\n\n${detail}` : ''}`))
    })
  })
}

async function mergeSegment(clips, onProgress, onProcess) {
  if (clips.length === 0) {
    throw new Error('This segment has no clips to merge.')
  }

  if (clips.some((clip) => !clip.rear)) {
    throw new Error('Every front clip needs a matching rear clip before this segment can be combined.')
  }

  const ffmpeg = findFfmpeg()

  if (!ffmpeg) {
    throw new Error('FFmpeg was not found. Install FFmpeg or set DASHCAM_CLIPPER_FFMPEG to the FFmpeg executable.')
  }

  const tempFolder = await getTempFolder()
  const outputPath = path.join(tempFolder, `merged-${crypto.randomUUID()}.mp4`)
  const encoder = findEncoder(ffmpeg)
  const args = buildMergeArguments(clips, outputPath, encoder.args)

  onProgress({ phase: `Combining with ${encoder.name}`, percent: 0 })
  await runFfmpeg(
    ffmpeg,
    args,
    clips.length * 60,
    (percent) => onProgress({ phase: `Combining with ${encoder.name}`, percent }),
    onProcess
  )

  return outputPath
}

function sanitizeClipName(name) {
  return name
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .slice(0, 100)
}

function formatFilenameDate(dateValue) {
  const date = new Date(dateValue)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day}_${hours}-${minutes}`
}

function processedFolder() {
  if (process.platform === 'darwin') {
    return '/Volumes/cloud/Videos/Dashcam/Processed'
  }

  return 'Y:\\Videos\\Dashcam\\Processed'
}

async function ensureProcessedFolder() {
  const destination = processedFolder()
  const root = process.platform === 'darwin' ? '/Volumes/cloud' : path.parse(destination).root

  try {
    await fs.access(root)
  } catch {
    throw new Error(`The archive location ${root} is not available. Connect the cloud drive and try again.`)
  }

  await fs.mkdir(destination, { recursive: true })
  return destination
}

async function saveTrimmedVideo(options, onProgress, onProcess) {
  const cleanName = sanitizeClipName(options.name)

  if (!cleanName) {
    throw new Error('Enter a name for the clip.')
  }

  const destinationFolder = await ensureProcessedFolder()
  const filename = `${formatFilenameDate(options.segmentStart)} ${cleanName}.mp4`
  const destinationPath = path.join(destinationFolder, filename)

  try {
    await fs.access(destinationPath)
    throw new Error(`A clip named ${filename} already exists. Rename or move the existing file, then try again.`)
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error
    }
  }

  const start = Math.max(0, Number(options.start) || 0)
  const end = Number(options.end)

  if (!Number.isFinite(end) || end <= start) {
    throw new Error('The ending point must be after the starting point.')
  }

  const ffmpeg = findFfmpeg()

  if (!ffmpeg) {
    throw new Error('FFmpeg was not found. Install FFmpeg or set DASHCAM_CLIPPER_FFMPEG to the FFmpeg executable.')
  }

  const temporaryPath = path.join(destinationFolder, `.dashcam-clipper-${crypto.randomUUID()}.mp4`)
  const duration = end - start
  const args = [
    '-y',
    '-ss',
    start.toFixed(3),
    '-i',
    options.sourcePath,
    '-t',
    duration.toFixed(3),
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-c',
    'copy',
    '-avoid_negative_ts',
    'make_zero',
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:1',
    '-nostats',
    temporaryPath
  ]

  try {
    onProgress({ phase: 'Saving the trimmed clip', percent: 0 })
    await runFfmpeg(
      ffmpeg,
      args,
      duration,
      (percent) => onProgress({ phase: 'Saving the trimmed clip', percent }),
      onProcess
    )
    await fs.rename(temporaryPath, destinationPath)
    await fs.rm(options.sourcePath, { force: true })
    return destinationPath
  } catch (error) {
    await fs.rm(temporaryPath, { force: true })
    throw error
  }
}

async function discardTemporaryVideo(filePath) {
  const tempFolder = await getTempFolder()
  const resolvedPath = path.resolve(filePath)
  const resolvedFolder = path.resolve(tempFolder)

  if (path.dirname(resolvedPath) !== resolvedFolder) {
    throw new Error('Dashcam Clipper can only discard its own temporary files.')
  }

  await fs.rm(resolvedPath, { force: true })
}

module.exports = {
  buildMergeArguments,
  buildThumbnailArguments,
  cleanupTemporaryFiles,
  discardTemporaryVideo,
  findEncoder,
  findFfmpeg,
  findVlc,
  formatFilenameDate,
  generateSegmentThumbnail,
  mergeSegment,
  parseProgressLine,
  playFileInVlc,
  playSegmentInVlc,
  processedFolder,
  sanitizeClipName,
  saveTrimmedVideo,
  setToolOverrides,
  validateToolExecutable
}
