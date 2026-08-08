const { spawn, spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fsSync = require('node:fs')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { sortClipsByName } = require('./clips')

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

function defaultFfmpegCandidates(platform = process.platform, environment = process.env) {
  const candidates = [
    environment.DASHCAM_CLIPPER_FFMPEG,
    environment.FFMPEG_PATH,
    'ffmpeg'
  ]

  if (platform === 'darwin') {
    candidates.push(
      '/opt/homebrew/bin/ffmpeg',
      '/usr/local/bin/ffmpeg',
      '/opt/local/bin/ffmpeg'
    )
  }

  return candidates
}

function findFfmpeg() {
  if (toolOverrides.ffmpegPath) {
    return canRun(toolOverrides.ffmpegPath) ? toolOverrides.ffmpegPath : null
  }

  return defaultFfmpegCandidates().find((candidate) => canRun(candidate)) || null
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
      (entry.name.startsWith('front-audio-') && entry.name.endsWith('.ffconcat')) ||
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

async function generateProcessedVideoThumbnail(fileName) {
  const ffmpeg = findFfmpeg()

  if (!ffmpeg) {
    return null
  }

  const filePath = processedVideoPath(fileName)
  const stats = await fs.stat(filePath)
  const cacheKey = crypto
    .createHash('sha1')
    .update(`${filePath}:${stats.size}:${stats.mtimeMs}`)
    .digest('hex')
  const tempFolder = await getTempFolder()
  const outputPath = path.join(tempFolder, `thumbnail-saved-${cacheKey}.jpg`)
  const existingImage = await fs.readFile(outputPath).catch(() => null)

  if (existingImage?.length > 0) {
    return `data:image/jpeg;base64,${existingImage.toString('base64')}`
  }

  try {
    const args = buildThumbnailArguments(filePath, outputPath)

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
  const lines = ['#EXTM3U', ...sortClipsByName(clips).map((clip) => clip.front.path)]
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

  return selectEncoder(
    encoders,
    process.platform,
    process.arch,
    (encoderArgs) => canEncode(ffmpeg, encoderArgs)
  )
}

function selectEncoder(encoders, platform, architecture, canUse) {
  const candidates = []

  if (platform === 'win32') {
    candidates.push(
      {
        codec: 'hevc_nvenc',
        name: 'NVIDIA HEVC',
        args: ['-c:v', 'hevc_nvenc', '-preset', 'p7', '-rc', 'vbr', '-cq', '32', '-b:v', '0', '-spatial-aq', '1']
      },
      {
        codec: 'hevc_amf',
        name: 'AMD AMF HEVC',
        args: ['-c:v', 'hevc_amf', '-quality', 'quality']
      },
      {
        codec: 'hevc_qsv',
        name: 'Intel Quick Sync HEVC',
        args: ['-c:v', 'hevc_qsv', '-preset', 'slower', '-global_quality', '30']
      },
      {
        codec: 'hevc_mf',
        name: 'Windows Media Foundation hardware HEVC',
        args: ['-c:v', 'hevc_mf', '-hw_encoding', '1', '-rate_control', 'quality', '-quality', '80']
      }
    )
  }

  if (platform === 'darwin') {
    candidates.push({
      codec: 'hevc_videotoolbox',
      name: architecture === 'arm64' ? 'Apple Silicon VideoToolbox HEVC' : 'Apple VideoToolbox HEVC',
      args: [
        '-c:v',
        'hevc_videotoolbox',
        '-b:v',
        '4500k',
        '-maxrate',
        '7000k',
        '-bufsize',
        '14000k',
        '-tag:v',
        'hvc1'
      ]
    })
  }

  candidates.push({
    codec: 'libx265',
    name: 'software HEVC',
    args: ['-c:v', 'libx265', '-preset', 'medium', '-crf', '30', '-tag:v', 'hvc1']
  })

  for (const candidate of candidates) {
    if (encoders.includes(candidate.codec) && canUse(candidate.args)) {
      return {
        name: candidate.name,
        args: candidate.args,
        hardware: candidate.codec !== 'libx265'
      }
    }
  }

  throw new Error('This FFmpeg installation does not contain a usable HEVC encoder. Install an FFmpeg build with GPU HEVC support or libx265.')
}

function findSoftwareEncoder(ffmpeg) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-encoders'], {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true
  })
  const encoders = `${result.stdout || ''}\n${result.stderr || ''}`
  const args = ['-c:v', 'libx265', '-preset', 'medium', '-crf', '30', '-tag:v', 'hvc1']

  if (encoders.includes('libx265') && canEncode(ffmpeg, args)) {
    return { name: 'software HEVC', args, hardware: false }
  }

  return null
}

function canEncode(ffmpeg, encoderArgs) {
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
    ...encoderArgs,
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

function buildMergeArguments(clips, outputPath, encoderArgs, options = {}) {
  const orderedClips = sortClipsByName(clips)
  const inputArgs = []
  const stackedVideos = []
  const concatInputs = []
  const mirrorRear = options.mirrorRear !== false

  if (!options.frontAudioPlaylistPath) {
    throw new Error('A front-camera audio playlist is required.')
  }

  orderedClips.forEach((clip, index) => {
    const frontInput = index * 2
    const rearInput = frontInput + 1
    inputArgs.push('-i', clip.front.path, '-i', clip.rear.path)

    if (mirrorRear) {
      stackedVideos.push(
        `[${rearInput}:v]split=2[rearBase${index}][rearFlip${index}]`,
        `[rearFlip${index}]crop=iw:ih-50:0:0,hflip[rearMain${index}]`,
        `[rearBase${index}][rearMain${index}]overlay=0:0[rear${index}]`,
        `[${frontInput}:v][rear${index}]vstack=inputs=2[v${index}]`
      )
    } else {
      stackedVideos.push(`[${frontInput}:v][${rearInput}:v]vstack=inputs=2[v${index}]`)
    }

    concatInputs.push(`[v${index}]`)
  })

  const frontAudioInput = orderedClips.length * 2
  inputArgs.push('-f', 'concat', '-safe', '0', '-i', options.frontAudioPlaylistPath)
  const filter = `${stackedVideos.join(';')};${concatInputs.join('')}concat=n=${orderedClips.length}:v=1:a=0[outv]`

  return [
    '-y',
    ...inputArgs,
    '-filter_complex',
    filter,
    '-map',
    '[outv]',
    '-map',
    `${frontAudioInput}:a:0`,
    ...encoderArgs,
    '-c:a',
    'copy',
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:1',
    '-nostats',
    outputPath
  ]
}

function buildFrontAudioPlaylist(clips) {
  const lines = sortClipsByName(clips).map((clip) => {
    const filePath = path.resolve(clip.front.path).replace(/\\/g, '/').replace(/'/g, "'\\''")
    return `file '${filePath}'`
  })

  return ['ffconcat version 1.0', ...lines].join(os.EOL)
}

async function createFrontAudioPlaylist(clips) {
  const tempFolder = await getTempFolder()
  const playlistPath = path.join(tempFolder, `front-audio-${crypto.randomUUID()}.ffconcat`)
  await fs.writeFile(playlistPath, buildFrontAudioPlaylist(clips), 'utf8')
  return playlistPath
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

async function mergeSegment(clips, options, onProgress, onProcess) {
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
  const frontAudioPlaylistPath = await createFrontAudioPlaylist(clips)
  let activeEncoder = encoder
  const mergeOptions = { ...options, frontAudioPlaylistPath }
  let args = buildMergeArguments(clips, outputPath, activeEncoder.args, mergeOptions)

  try {
    onProgress({ phase: `Combining with ${activeEncoder.name}`, percent: 0 })

    try {
      await runFfmpeg(
        ffmpeg,
        args,
        clips.length * 60,
        (percent) => onProgress({ phase: `Combining with ${activeEncoder.name}`, percent }),
        onProcess
      )
    } catch (error) {
      if (!activeEncoder.hardware || /cancelled/i.test(error.message)) {
        throw error
      }

      const softwareEncoder = findSoftwareEncoder(ffmpeg)

      if (!softwareEncoder) {
        throw error
      }

      activeEncoder = softwareEncoder
      args = buildMergeArguments(clips, outputPath, activeEncoder.args, mergeOptions)
      onProgress({ phase: 'GPU HEVC failed, retrying with software HEVC', percent: 0 })
      await runFfmpeg(
        ffmpeg,
        args,
        clips.length * 60,
        (percent) => onProgress({ phase: `Combining with ${activeEncoder.name}`, percent }),
        onProcess
      )
    }

    return outputPath
  } finally {
    await fs.rm(frontAudioPlaylistPath, { force: true })
  }
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

function applyFilenameDateOverrides(dateValue, dateOverride = '', timeOverride = '') {
  const adjustedDate = new Date(dateValue)

  if (Number.isNaN(adjustedDate.getTime())) {
    throw new Error('The automatic filename date is invalid.')
  }

  if (dateOverride) {
    const dateMatch = dateOverride.match(/^(\d{4})-(\d{2})-(\d{2})$/)

    if (!dateMatch) {
      throw new Error('The filename date is invalid.')
    }

    const year = Number(dateMatch[1])
    const month = Number(dateMatch[2])
    const day = Number(dateMatch[3])
    const dateCheck = new Date(year, month - 1, day)

    if (dateCheck.getFullYear() !== year || dateCheck.getMonth() !== month - 1 || dateCheck.getDate() !== day) {
      throw new Error('The filename date is invalid.')
    }

    adjustedDate.setFullYear(year, month - 1, day)
  }

  if (timeOverride) {
    const timeMatch = timeOverride.match(/^([01]\d|2[0-3]):([0-5]\d)$/)

    if (!timeMatch) {
      throw new Error('The filename time is invalid.')
    }

    adjustedDate.setHours(Number(timeMatch[1]), Number(timeMatch[2]), 0, 0)
  }

  return adjustedDate
}

function processedFolder() {
  if (process.platform === 'darwin') {
    return '/Volumes/cloud/Videos/Dashcam/Processed'
  }

  return 'Y:\\Videos\\Dashcam\\Processed'
}

function buildProcessedFilename(dateValue, name, clipRange) {
  const cleanName = sanitizeClipName(name)

  if (!cleanName) {
    throw new Error('Enter a name for the clip.')
  }

  return `${formatFilenameDate(dateValue)} ${cleanName}.mp4`
}

function extractProcessedClipName(filename) {
  return parseProcessedVideoFilename(filename)?.title || null
}

function parseProcessedVideoFilename(filename) {
  const match = filename.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})\s+(.+?)(?:\s+\((\d+)(?:\s+-\s+(\d+))?\))?\.mp4$/i)

  if (!match) {
    return null
  }

  const recordedAt = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hours: Number(match[4]),
    minutes: Number(match[5])
  }
  const date = new Date(recordedAt.year, recordedAt.month - 1, recordedAt.day, recordedAt.hours, recordedAt.minutes)
  const isValid = date.getFullYear() === recordedAt.year &&
    date.getMonth() === recordedAt.month - 1 &&
    date.getDate() === recordedAt.day &&
    date.getHours() === recordedAt.hours &&
    date.getMinutes() === recordedAt.minutes

  if (!isValid) {
    return null
  }

  return {
    title: match[6].trim(),
    recordedAt,
    clipRange: match[7]
      ? { start: Number(match[7]), end: Number(match[8] || match[7]) }
      : null
  }
}

function dateFromProcessedVideoFilename(filename) {
  const parsed = parseProcessedVideoFilename(filename)

  if (!parsed) {
    return null
  }

  return new Date(
    parsed.recordedAt.year,
    parsed.recordedAt.month - 1,
    parsed.recordedAt.day,
    parsed.recordedAt.hours,
    parsed.recordedAt.minutes
  )
}

function rankProcessedClipNames(filenames, limit = 5) {
  const names = new Map()

  for (const filename of filenames) {
    const name = extractProcessedClipName(filename)

    if (!name) {
      continue
    }

    const key = name.toLocaleLowerCase()
    const existing = names.get(key)
    names.set(key, existing ? { name: existing.name, count: existing.count + 1 } : { name, count: 1 })
  }

  return [...names.values()]
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
    .slice(0, limit)
    .map((entry) => entry.name)
}

async function getProcessedNameSuggestions() {
  try {
    const entries = await fs.readdir(processedFolder(), { withFileTypes: true })
    const filenames = entries
      .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.mp4')
      .map((entry) => entry.name)
    return rankProcessedClipNames(filenames)
  } catch {
    return []
  }
}

function processedVideoPath(fileName) {
  if (typeof fileName !== 'string' || !fileName || /[\\/]/.test(fileName) || path.extname(fileName).toLowerCase() !== '.mp4') {
    throw new Error('Choose a saved MP4 video from the list.')
  }

  return path.join(processedFolder(), fileName)
}

async function listProcessedVideos(folderPath = processedFolder()) {
  const root = path.parse(folderPath).root

  try {
    await fs.access(root)
  } catch {
    throw new Error(`The archive location ${root} is not available. Connect the cloud drive and try again.`)
  }

  let entries

  try {
    entries = await fs.readdir(folderPath, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') {
      return []
    }

    throw error
  }

  const videos = await Promise.all(entries
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.mp4')
    .map(async (entry) => {
      const stats = await fs.stat(path.join(folderPath, entry.name))
      const parsedName = parseProcessedVideoFilename(entry.name)
      return {
        name: entry.name,
        title: parsedName?.title || path.parse(entry.name).name,
        recordedAt: parsedName?.recordedAt || null,
        clipRange: parsedName?.clipRange || null,
        modifiedAt: stats.mtime.toISOString()
      }
    }))
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
  return videos.sort((left, right) => collator.compare(right.name, left.name))
}

async function playProcessedVideo(fileName) {
  const filePath = processedVideoPath(fileName)
  await fs.access(filePath)
  playFileInVlc(filePath)
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

function buildTrimArguments(sourcePath, outputPath, start, duration, dateValue) {
  const creationTime = new Date(dateValue).toISOString()

  return [
    '-y',
    '-ss',
    start.toFixed(3),
    '-i',
    sourcePath,
    '-t',
    duration.toFixed(3),
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-map_metadata',
    '0',
    '-c',
    'copy',
    '-metadata',
    `creation_time=${creationTime}`,
    '-metadata:s:v:0',
    `creation_time=${creationTime}`,
    '-avoid_negative_ts',
    'make_zero',
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:1',
    '-nostats',
    outputPath
  ]
}

function buildDateMetadataArguments(sourcePath, outputPath, dateValue) {
  const creationTime = new Date(dateValue).toISOString()

  return [
    '-y',
    '-i',
    sourcePath,
    '-map',
    '0',
    '-map_metadata',
    '0',
    '-c',
    'copy',
    '-metadata',
    `creation_time=${creationTime}`,
    '-metadata:s:v:0',
    `creation_time=${creationTime}`,
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:1',
    '-nostats',
    outputPath
  ]
}

async function replaceVideoFile(sourcePath, replacementPath) {
  const backupPath = `${sourcePath}.dashcam-clipper-backup-${crypto.randomUUID()}`
  await fs.rename(sourcePath, backupPath)

  try {
    await fs.rename(replacementPath, sourcePath)
  } catch (error) {
    try {
      await fs.rename(backupPath, sourcePath)
    } catch (restoreError) {
      throw new Error(`The updated file could not be installed and the original is stored at ${backupPath}. ${restoreError.message}`)
    }

    throw error
  }

  await fs.rm(backupPath, { force: true })
}

async function applyFilenameDateToVideo(filePath, onProgress, onProcess) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || path.extname(filePath).toLowerCase() !== '.mp4') {
    throw new Error('Choose an MP4 video whose filename starts with YYYY-MM-DD_HH-mm.')
  }

  const sourcePath = path.resolve(filePath)
  const filenameDate = dateFromProcessedVideoFilename(path.basename(sourcePath))

  if (!filenameDate) {
    throw new Error('The filename must match YYYY-MM-DD_HH-mm Name (first - last).mp4.')
  }

  const stats = await fs.stat(sourcePath)

  if (!stats.isFile()) {
    throw new Error('Choose a video file.')
  }

  const ffmpeg = findFfmpeg()

  if (!ffmpeg) {
    throw new Error('FFmpeg was not found. Install FFmpeg or choose its executable in Settings.')
  }

  const temporaryPath = path.join(path.dirname(sourcePath), `.dashcam-clipper-date-${crypto.randomUUID()}.mp4`)
  const args = buildDateMetadataArguments(sourcePath, temporaryPath, filenameDate)

  try {
    onProgress({ phase: 'Embedding the filename date', percent: 0 })
    await runFfmpeg(
      ffmpeg,
      args,
      0,
      (percent) => onProgress({ phase: 'Embedding the filename date', percent }),
      onProcess
    )
    await fs.chmod(temporaryPath, stats.mode).catch(() => {})
    await fs.utimes(temporaryPath, filenameDate, filenameDate)
    await replaceVideoFile(sourcePath, temporaryPath)

    return {
      filePath: sourcePath,
      fileName: path.basename(sourcePath),
      recordedAt: filenameDate.toISOString()
    }
  } catch (error) {
    await fs.rm(temporaryPath, { force: true })
    throw error
  }
}

async function saveTrimmedVideo(options, onProgress, onProcess) {
  const destinationFolder = await ensureProcessedFolder()
  const generatedFilename = buildProcessedFilename(options.filenameDate, options.name, options.clipRange)
  const filename = options.replaceFileName || generatedFilename
  const destinationPath = path.join(destinationFolder, filename)
  const replaceExisting = typeof options.replaceFileName === 'string' && options.replaceFileName.length > 0

  if (replaceExisting && processedVideoPath(options.replaceFileName) !== destinationPath) {
    throw new Error('The saved video replacement path is invalid.')
  }

  if (!replaceExisting) {
    try {
      await fs.access(destinationPath)
      throw new Error(`A clip named ${filename} already exists. Rename or move the existing file, then try again.`)
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error
      }
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
  const filenameDate = new Date(options.filenameDate)
  const args = buildTrimArguments(options.sourcePath, temporaryPath, start, duration, filenameDate)

  try {
    onProgress({ phase: 'Saving the trimmed clip', percent: 0 })
    await runFfmpeg(
      ffmpeg,
      args,
      duration,
      (percent) => onProgress({ phase: 'Saving the trimmed clip', percent }),
      onProcess
    )
    await fs.utimes(temporaryPath, filenameDate, filenameDate)

    if (replaceExisting) {
      await replaceVideoFile(destinationPath, temporaryPath)
    } else {
      await fs.rename(temporaryPath, destinationPath)
    }

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
  applyFilenameDateOverrides,
  applyFilenameDateToVideo,
  buildDateMetadataArguments,
  buildMergeArguments,
  buildProcessedFilename,
  buildFrontAudioPlaylist,
  buildThumbnailArguments,
  buildTrimArguments,
  cleanupTemporaryFiles,
  dateFromProcessedVideoFilename,
  defaultFfmpegCandidates,
  discardTemporaryVideo,
  findEncoder,
  findFfmpeg,
  findVlc,
  formatFilenameDate,
  generateSegmentThumbnail,
  generateProcessedVideoThumbnail,
  getProcessedNameSuggestions,
  listProcessedVideos,
  mergeSegment,
  extractProcessedClipName,
  parseProgressLine,
  parseProcessedVideoFilename,
  playFileInVlc,
  playProcessedVideo,
  playSegmentInVlc,
  processedFolder,
  processedVideoPath,
  rankProcessedClipNames,
  replaceVideoFile,
  selectEncoder,
  sanitizeClipName,
  saveTrimmedVideo,
  setToolOverrides,
  validateToolExecutable
}
