const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')

const VIDEO_EXTENSIONS = new Set(['.avi', '.mp4', '.mov', '.mkv'])
const SEGMENT_GAP_MS = 3 * 60 * 1000

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
    files.push({
      path: fullPath,
      name: entry.name,
      relativeKey: path.relative(basePath, fullPath).split(path.sep).join('/').toLowerCase(),
      baseKey: entry.name.toLowerCase(),
      recordedAt: stats.mtime,
      size: stats.size
    })
  }

  return files
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
      recordedAt: front.recordedAt,
      front,
      rear: rear || null,
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
    if (clip.recordedAt < start) {
      return false
    }

    if (end && clip.recordedAt > end) {
      return false
    }

    return true
  })
}

function createSegment(clips) {
  const firstClip = clips[0]
  const lastClip = clips[clips.length - 1]
  const fingerprint = clips.map((clip) => clip.front.path).join('\n')

  return {
    id: crypto.createHash('sha1').update(fingerprint).digest('hex').slice(0, 16),
    start: firstClip.recordedAt,
    end: lastClip.recordedAt,
    durationMs: Math.max(60 * 1000, lastClip.recordedAt - firstClip.recordedAt + 60 * 1000),
    clipCount: clips.length,
    pairedCount: clips.filter((clip) => clip.rear).length,
    totalSize: clips.reduce((total, clip) => total + clip.size, 0),
    clips
  }
}

function groupSegments(clips, maximumGapMs = SEGMENT_GAP_MS) {
  const sortedClips = [...clips].sort((left, right) => left.recordedAt - right.recordedAt)
  const groups = []
  let currentGroup = []

  for (const clip of sortedClips) {
    const previousClip = currentGroup[currentGroup.length - 1]

    if (previousClip && clip.recordedAt - previousClip.recordedAt > maximumGapMs) {
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

async function scanSource(rootPath, filters = {}) {
  const { frontPath, rearPath } = await findCameraFolders(rootPath)
  const [frontFiles, rearFiles] = await Promise.all([
    readVideoFiles(frontPath),
    readVideoFiles(rearPath)
  ])
  const pairing = pairCameraFiles(frontFiles, rearFiles)
  const filteredClips = filterClips(pairing.clips, filters)
  const segments = groupSegments(filteredClips)

  return {
    rootPath,
    frontPath,
    rearPath,
    segments,
    totals: {
      front: frontFiles.length,
      rear: rearFiles.length,
      visible: filteredClips.length,
      unpairedRear: pairing.unpairedRearCount
    }
  }
}

function toPublicSegment(segment) {
  return {
    id: segment.id,
    start: segment.start.toISOString(),
    end: segment.end.toISOString(),
    durationMs: segment.durationMs,
    clipCount: segment.clipCount,
    pairedCount: segment.pairedCount,
    totalSize: segment.totalSize
  }
}

module.exports = {
  SEGMENT_GAP_MS,
  filterClips,
  findCameraFolders,
  groupSegments,
  pairCameraFiles,
  parseLocalDate,
  readVideoFiles,
  scanSource,
  toPublicSegment
}
