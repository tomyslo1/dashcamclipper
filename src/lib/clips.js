const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const { readProcessingMetadata } = require('./processing-metadata')

const VIDEO_EXTENSIONS = new Set(['.avi', '.mp4', '.mov', '.mkv'])
const SEGMENT_GAP_MS = 3 * 60 * 1000
const OUTLIER_DATE_GAP_MS = 12 * 60 * 60 * 1000
const FILENAME_COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

async function findCameraFolders(rootPath) {
  const entries = await fs.readdir(rootPath, { withFileTypes: true })
  const folders = new Map()

  for (const entry of entries) {
    if (entry.isDirectory()) {
      folders.set(entry.name.toUpperCase(), path.join(rootPath, entry.name))
    }
  }

  const missing = ['DCIMA', 'DCIMB'].filter((name) => !folders.has(name))

  if (missing.length > 0) {
    const folderWord = missing.length === 1 ? 'folder is' : 'folders are'
    throw new Error(`${missing.join(' and ')} ${folderWord} missing. Select the folder that contains both DCIMA and DCIMB.`)
  }

  return {
    frontPath: folders.get('DCIMA'),
    rearPath: folders.get('DCIMB')
  }
}

async function readVideoFiles(folderPath, basePath = folderPath) {
  const entries = await fs.readdir(folderPath, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const fullPath = path.join(folderPath, entry.name)

    if (entry.isDirectory()) {
      files.push(...await readVideoFiles(fullPath, basePath))
      continue
    }

    if (!entry.isFile() || !VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      continue
    }

    const stats = await fs.stat(fullPath)
    const relativePath = path.relative(basePath, fullPath).split(path.sep).join('/')
    files.push({
      path: fullPath,
      name: entry.name,
      relativePath,
      relativeKey: relativePath.toLowerCase(),
      baseKey: entry.name.toLowerCase(),
      recordedAt: stats.mtime,
      size: stats.size
    })
  }

  return files
}

async function findOriginalClips(rootPath, clipRange) {
  const start = Number(clipRange?.start)
  const end = Number(clipRange?.end)

  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end - start > 5000) {
    throw new Error('The saved filename does not contain a usable original clip range.')
  }

  const cameraFolders = await findCameraFolders(rootPath)
  const [frontFiles, rearFiles] = await Promise.all([
    readVideoFiles(cameraFolders.frontPath),
    readVideoFiles(cameraFolders.rearPath)
  ])
  const clips = []

  for (let number = start; number <= end; number += 1) {
    const frontMatches = frontFiles.filter((file) => parseClipNumber(file.name) === number)

    if (frontMatches.length === 0) {
      throw new Error(`Original front clip ${number} is missing from DCIMA.`)
    }

    if (frontMatches.length > 1) {
      throw new Error(`Original front clip ${number} appears more than once in DCIMA, so it cannot be selected safely.`)
    }

    const front = frontMatches[0]
    const matchingRearPath = rearFiles.filter((file) => file.relativeKey === front.relativeKey)
    const rearMatches = matchingRearPath.length > 0
      ? matchingRearPath
      : rearFiles.filter((file) => parseClipNumber(file.name) === number)

    if (rearMatches.length === 0) {
      throw new Error(`Original rear clip ${number} is missing from DCIMB.`)
    }

    if (rearMatches.length > 1) {
      throw new Error(`Original rear clip ${number} appears more than once in DCIMB, so it cannot be selected safely.`)
    }

    const rear = rearMatches[0]
    clips.push({
      key: front.relativeKey,
      recordedAt: front.recordedAt,
      front,
      rear,
      processed: false,
      processedAt: null,
      newFront: false,
      newRear: false,
      newToLibrary: false,
      size: front.size + rear.size
    })
  }

  return sortClipsByName(clips)
}

function pairCameraFiles(frontFiles, rearFiles) {
  const availableRearFiles = new Set(rearFiles.map((file) => file.path))
  const rearByRelativePath = new Map(rearFiles.map((file) => [file.relativeKey, file]))
  const rearByBaseName = new Map()

  for (const file of rearFiles) {
    const matches = rearByBaseName.get(file.baseKey) || []
    matches.push(file)
    rearByBaseName.set(file.baseKey, matches)
  }

  const sortedFrontFiles = [...frontFiles].sort((left, right) => left.recordedAt - right.recordedAt)
  const clips = []

  for (const front of sortedFrontFiles) {
    let rear = rearByRelativePath.get(front.relativeKey)

    if (rear && !availableRearFiles.has(rear.path)) {
      rear = null
    }

    if (!rear) {
      const sameNameMatches = (rearByBaseName.get(front.baseKey) || [])
        .filter((file) => availableRearFiles.has(file.path))

      if (sameNameMatches.length === 1) {
        rear = sameNameMatches[0]
      }
    }

    if (!rear) {
      rear = rearFiles
        .filter((file) => availableRearFiles.has(file.path))
        .map((file) => ({ file, distance: Math.abs(file.recordedAt - front.recordedAt) }))
        .filter((match) => match.distance <= 30 * 1000)
        .sort((left, right) => left.distance - right.distance)[0]?.file
    }

    if (rear) {
      availableRearFiles.delete(rear.path)
    }

    clips.push({
      key: front.relativeKey,
      recordedAt: front.recordedAt,
      front,
      rear: rear || null,
      processed: false,
      processedAt: null,
      newFront: false,
      newRear: false,
      newToLibrary: false,
      size: front.size + (rear?.size || 0)
    })
  }

  return {
    clips,
    unpairedRearCount: availableRearFiles.size
  }
}

function parseLocalDate(dateValue, timeValue, endOfDay = false) {
  if (!dateValue) {
    return null
  }

  const time = timeValue || (endOfDay ? '23:59:59.999' : '00:00:00.000')
  const date = new Date(`${dateValue}T${time}`)

  if (Number.isNaN(date.getTime())) {
    throw new Error('The selected date or time is invalid.')
  }

  return date
}

function filterClips(clips, filters = {}) {
  if (filters.mode !== 'range') {
    return clips
  }

  if (!filters.startDate) {
    throw new Error('Choose a starting date or select Show all clips.')
  }

  const start = parseLocalDate(filters.startDate, filters.startTime)
  const end = parseLocalDate(filters.endDate, filters.endTime, true)

  if (end && end < start) {
    throw new Error('The ending date and time must be after the starting date and time.')
  }

  return clips.filter((clip) => {
    const timelineAt = clip.timelineAt || clip.recordedAt

    if (timelineAt < start) {
      return false
    }

    if (end && timelineAt > end) {
      return false
    }

    return true
  })
}

function parseClipNumber(filename) {
  const match = path.basename(filename, path.extname(filename)).match(/(\d+)$/)
  return match ? Number(match[1]) : null
}

function compareClipsByName(left, right) {
  const leftName = left.front.name || path.basename(left.front.path)
  const rightName = right.front.name || path.basename(right.front.path)
  const nameResult = FILENAME_COLLATOR.compare(leftName, rightName)

  if (nameResult !== 0) {
    return nameResult
  }

  return FILENAME_COLLATOR.compare(left.front.relativePath || left.front.path, right.front.relativePath || right.front.path)
}

function sortClipsByName(clips) {
  return [...clips].sort(compareClipsByName)
}

function clipSequenceIdentity(clip) {
  const relativePath = (clip.front.relativePath || clip.front.name).split(path.sep).join('/')
  const extension = path.posix.extname(relativePath)
  const directory = path.posix.dirname(relativePath)
  const basename = path.posix.basename(relativePath, extension)
  const match = basename.match(/^(.*?)(\d+)$/)

  if (!match) {
    return null
  }

  return {
    group: `${directory}/${match[1].toLowerCase()}${extension.toLowerCase()}`,
    number: Number(match[2])
  }
}

function reconcileClipTimeline(clips, maximumGapMs = SEGMENT_GAP_MS) {
  const sequences = new Map()

  for (const clip of clips) {
    clip.timelineAt = new Date(clip.recordedAt)
    clip.timelineAdjusted = false
    const identity = clipSequenceIdentity(clip)

    if (!identity) {
      continue
    }

    const sequence = sequences.get(identity.group) || new Map()
    const matches = sequence.get(identity.number) || []
    matches.push(clip)
    sequence.set(identity.number, matches)
    sequences.set(identity.group, sequence)
  }

  for (const sequence of sequences.values()) {
    const numbers = [...sequence.keys()].sort((left, right) => right - left)

    for (const number of numbers) {
      const matches = sequence.get(number)
      const successorMatches = sequence.get(number + 1)

      if (matches.length !== 1 || successorMatches?.length !== 1) {
        continue
      }

      const clip = matches[0]
      const successor = successorMatches[0]
      const dateGap = successor.timelineAt - clip.recordedAt

      if (dateGap < OUTLIER_DATE_GAP_MS) {
        continue
      }

      const predecessorMatches = sequence.get(number - 1)
      const followingMatches = sequence.get(number + 2)
      const predecessor = predecessorMatches?.length === 1 ? predecessorMatches[0] : null
      const following = followingMatches?.length === 1 ? followingMatches[0] : null
      const currentContinuesPredecessor = predecessor && Math.abs(clip.recordedAt - predecessor.timelineAt) <= maximumGapMs
      const predecessorAnchorsSequence = predecessor && Math.abs(successor.timelineAt - predecessor.timelineAt) <= maximumGapMs * 2
      const followingAnchorsSequence = following && Math.abs(following.timelineAt - successor.timelineAt) <= maximumGapMs

      if (currentContinuesPredecessor || (!predecessorAnchorsSequence && !followingAnchorsSequence)) {
        continue
      }

      clip.timelineAt = new Date(successor.timelineAt - 60 * 1000)
      clip.timelineAdjusted = true
    }
  }

  return clips
}

function createClipRange(clips) {
  const start = parseClipNumber(clips[0]?.front.name || '')
  const end = parseClipNumber(clips[clips.length - 1]?.front.name || '')

  if (start === null || end === null) {
    return null
  }

  return { start, end }
}

function createSegment(clips) {
  const orderedClips = sortClipsByName(clips)
  const timelineValues = orderedClips.map((clip) => Number(clip.timelineAt || clip.recordedAt))
  const start = new Date(Math.min(...timelineValues))
  const end = new Date(Math.max(...timelineValues))
  const filenameClip = orderedClips[Math.min(1, orderedClips.length - 1)]
  const fingerprint = orderedClips.map((clip) => clip.front.path).join('\n')

  const segment = {
    id: crypto.createHash('sha1').update(fingerprint).digest('hex').slice(0, 16),
    start,
    end,
    filenameDate: filenameClip.recordedAt,
    clipRange: createClipRange(orderedClips),
    durationMs: Math.max(60 * 1000, end - start + 60 * 1000),
    clipCount: orderedClips.length,
    pairedCount: orderedClips.filter((clip) => clip.rear).length,
    totalSize: orderedClips.reduce((total, clip) => total + clip.size, 0),
    clips: orderedClips
  }

  refreshSegmentProcessing(segment)
  refreshSegmentImport(segment)
  return segment
}

function refreshSegmentProcessing(segment) {
  segment.processedCount = segment.clips.filter((clip) => clip.processed).length
  segment.processed = segment.clips.length > 0 && segment.processedCount === segment.clips.length
  return segment
}

function applyProcessingMetadata(segments, metadata) {
  for (const segment of segments) {
    for (const clip of segment.clips) {
      clip.processedAt = metadata.processedClips[clip.key] || null
      clip.processed = Boolean(clip.processedAt)
    }

    refreshSegmentProcessing(segment)
  }

  return segments
}

function refreshSegmentImport(segment) {
  segment.newClipCount = segment.clips.filter((clip) => clip.newToLibrary).length
  return segment
}

function pathsEqual(leftPath, rightPath) {
  const left = path.resolve(leftPath)
  const right = path.resolve(rightPath)

  if (process.platform === 'win32') {
    return left.toLowerCase() === right.toLowerCase()
  }

  return left === right
}

function groupSegments(clips, maximumGapMs = SEGMENT_GAP_MS) {
  if (clips.some((clip) => !clip.timelineAt)) {
    reconcileClipTimeline(clips, maximumGapMs)
  }
  const sortedClips = [...clips].sort((left, right) => left.timelineAt - right.timelineAt)
  const groups = []
  let currentGroup = []

  for (const clip of sortedClips) {
    const previousClip = currentGroup[currentGroup.length - 1]

    if (previousClip && clip.timelineAt - previousClip.timelineAt > maximumGapMs) {
      groups.push(createSegment(currentGroup))
      currentGroup = []
    }

    currentGroup.push(clip)
  }

  if (currentGroup.length > 0) {
    groups.push(createSegment(currentGroup))
  }

  return groups
}

async function scanSource(rootPath, filters = {}, libraryRootPath = rootPath, maximumGapMs = SEGMENT_GAP_MS) {
  const sourceFolders = await findCameraFolders(rootPath)
  const sourceIsLibrary = pathsEqual(rootPath, libraryRootPath)
  const libraryFolders = sourceIsLibrary
    ? sourceFolders
    : await findCameraFolders(libraryRootPath)
  const sourceFiles = await Promise.all([
    readVideoFiles(sourceFolders.frontPath),
    readVideoFiles(sourceFolders.rearPath)
  ])
  const libraryFiles = sourceIsLibrary
    ? sourceFiles
    : await Promise.all([
        readVideoFiles(libraryFolders.frontPath),
        readVideoFiles(libraryFolders.rearPath)
      ])
  const [frontFiles, rearFiles] = sourceFiles
  const [libraryFrontFiles, libraryRearFiles] = libraryFiles
  const metadata = await readProcessingMetadata(libraryRootPath)
  const libraryFrontKeys = new Set(libraryFrontFiles.map((file) => file.relativeKey))
  const libraryRearKeys = new Set(libraryRearFiles.map((file) => file.relativeKey))
  const importPlan = []

  if (!sourceIsLibrary) {
    for (const file of frontFiles) {
      if (!libraryFrontKeys.has(file.relativeKey)) {
        importPlan.push({
          camera: 'front',
          sourcePath: file.path,
          relativePath: file.relativePath,
          relativeKey: file.relativeKey,
          size: file.size
        })
      }
    }

    for (const file of rearFiles) {
      if (!libraryRearKeys.has(file.relativeKey)) {
        importPlan.push({
          camera: 'rear',
          sourcePath: file.path,
          relativePath: file.relativePath,
          relativeKey: file.relativeKey,
          size: file.size
        })
      }
    }
  }

  const pairing = pairCameraFiles(frontFiles, rearFiles)
  reconcileClipTimeline(pairing.clips, maximumGapMs)

  for (const clip of pairing.clips) {
    clip.newFront = !sourceIsLibrary && !libraryFrontKeys.has(clip.front.relativeKey)
    clip.newRear = !sourceIsLibrary && Boolean(clip.rear) && !libraryRearKeys.has(clip.rear.relativeKey)
    clip.newToLibrary = clip.newFront || clip.newRear
  }

  const filteredClips = filterClips(pairing.clips, filters)
  const segments = groupSegments(filteredClips, maximumGapMs)
  applyProcessingMetadata(segments, metadata)

  return {
    rootPath,
    frontPath: sourceFolders.frontPath,
    rearPath: sourceFolders.rearPath,
    libraryRootPath,
    libraryFrontPath: libraryFolders.frontPath,
    libraryRearPath: libraryFolders.rearPath,
    sourceIsLibrary,
    importPlan,
    segments,
    totals: {
      front: frontFiles.length,
      rear: rearFiles.length,
      visible: filteredClips.length,
      processedVisible: filteredClips.filter((clip) => clip.processed).length,
      newFront: importPlan.filter((item) => item.camera === 'front').length,
      newRear: importPlan.filter((item) => item.camera === 'rear').length,
      newBytes: importPlan.reduce((total, item) => total + item.size, 0),
      unpairedRear: pairing.unpairedRearCount
    }
  }
}

function toPublicSegment(segment) {
  return {
    id: segment.id,
    start: segment.start.toISOString(),
    end: segment.end.toISOString(),
    filenameDate: segment.filenameDate.toISOString(),
    clipRange: segment.clipRange,
    durationMs: segment.durationMs,
    clipCount: segment.clipCount,
    pairedCount: segment.pairedCount,
    totalSize: segment.totalSize,
    processedCount: segment.processedCount,
    processed: segment.processed,
    newClipCount: segment.newClipCount,
    clips: segment.clips.map((clip) => ({
      key: clip.key,
      recordedAt: clip.recordedAt.toISOString(),
      timelineAt: (clip.timelineAt || clip.recordedAt).toISOString(),
      timelineAdjusted: clip.timelineAdjusted,
      fileName: clip.front.name,
      hasRear: Boolean(clip.rear),
      processed: clip.processed,
      processedAt: clip.processedAt,
      newFront: clip.newFront,
      newRear: clip.newRear,
      newToLibrary: clip.newToLibrary
    }))
  }
}

module.exports = {
  SEGMENT_GAP_MS,
  OUTLIER_DATE_GAP_MS,
  createClipRange,
  compareClipsByName,
  findOriginalClips,
  filterClips,
  applyProcessingMetadata,
  findCameraFolders,
  groupSegments,
  pairCameraFiles,
  parseClipNumber,
  parseLocalDate,
  readVideoFiles,
  reconcileClipTimeline,
  refreshSegmentProcessing,
  refreshSegmentImport,
  pathsEqual,
  scanSource,
  sortClipsByName,
  toPublicSegment
}
