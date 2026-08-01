const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')

const METADATA_DIRECTORY = 'dashcamclipper'
const METADATA_FILENAME = 'metadata.json'

function emptyMetadata() {
  return {
    version: 1,
    updatedAt: null,
    processedClips: {}
  }
}

function cleanMetadata(value) {
  const processedClips = {}

  if (value?.processedClips && typeof value.processedClips === 'object') {
    for (const [clipKey, processedAt] of Object.entries(value.processedClips)) {
      if (typeof clipKey === 'string' && typeof processedAt === 'string') {
        processedClips[clipKey.toLowerCase()] = processedAt
      }
    }
  }

  return {
    version: 1,
    updatedAt: typeof value?.updatedAt === 'string' ? value.updatedAt : null,
    processedClips
  }
}

function metadataPaths(rootPath) {
  const directoryPath = path.join(rootPath, METADATA_DIRECTORY)
  return {
    directoryPath,
    filePath: path.join(directoryPath, METADATA_FILENAME)
  }
}

async function writeProcessingMetadata(rootPath, metadata) {
  const cleanValue = cleanMetadata(metadata)
  const { directoryPath, filePath } = metadataPaths(rootPath)
  const temporaryPath = path.join(directoryPath, `.metadata-${process.pid}-${crypto.randomUUID()}.tmp`)
  await fs.mkdir(directoryPath, { recursive: true })

  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(cleanValue, null, 2)}\n`, 'utf8')
    await fs.rename(temporaryPath, filePath)
  } finally {
    await fs.rm(temporaryPath, { force: true })
  }

  return cleanValue
}

async function readProcessingMetadata(rootPath) {
  const { directoryPath, filePath } = metadataPaths(rootPath)

  try {
    await fs.mkdir(directoryPath, { recursive: true })
  } catch {
    throw new Error(`Dashcam Clipper could not create ${directoryPath}. Check that the source is writable.`)
  }

  let contents

  try {
    contents = await fs.readFile(filePath, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new Error(`Dashcam Clipper could not read ${filePath}.`)
    }

    return writeProcessingMetadata(rootPath, emptyMetadata())
  }

  try {
    return cleanMetadata(JSON.parse(contents))
  } catch {
    throw new Error(`${filePath} is not valid JSON. Fix or rename it before scanning again.`)
  }
}

async function setClipsProcessed(rootPath, clipKeys, processed) {
  const metadata = await readProcessingMetadata(rootPath)
  const updatedAt = new Date().toISOString()

  for (const clipKey of new Set(clipKeys.map((key) => key.toLowerCase()))) {
    if (processed) {
      metadata.processedClips[clipKey] = updatedAt
    } else {
      delete metadata.processedClips[clipKey]
    }
  }

  metadata.updatedAt = updatedAt
  return writeProcessingMetadata(rootPath, metadata)
}

module.exports = {
  METADATA_DIRECTORY,
  METADATA_FILENAME,
  cleanMetadata,
  emptyMetadata,
  metadataPaths,
  readProcessingMetadata,
  setClipsProcessed,
  writeProcessingMetadata
}
