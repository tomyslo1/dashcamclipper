const { createReadStream, createWriteStream } = require('node:fs')
const fs = require('node:fs/promises')
const path = require('node:path')
const { pipeline } = require('node:stream/promises')

function destinationForImport(item, cameraFolders) {
  if (!['front', 'rear'].includes(item.camera)) {
    throw new Error('A clip has an invalid camera type.')
  }

  const cameraFolder = item.camera === 'front' ? cameraFolders.frontPath : cameraFolders.rearPath
  const parts = item.relativePath.split('/').filter(Boolean)

  if (parts.length === 0 || parts.some((part) => part === '.' || part === '..')) {
    throw new Error('A clip has an invalid relative path.')
  }

  const destinationPath = path.resolve(cameraFolder, ...parts)
  const resolvedCameraFolder = path.resolve(cameraFolder)
  const pathPrefix = `${resolvedCameraFolder}${path.sep}`
  const normalizedDestination = process.platform === 'win32' ? destinationPath.toLowerCase() : destinationPath
  const normalizedPrefix = process.platform === 'win32' ? pathPrefix.toLowerCase() : pathPrefix

  if (!normalizedDestination.startsWith(normalizedPrefix)) {
    throw new Error('A clip would be copied outside its camera folder.')
  }

  return destinationPath
}

async function copyImportPlan(importPlan, cameraFolders, onProgress = () => {}, isCancelled = () => false) {
  let copied = 0
  let skipped = 0

  for (let index = 0; index < importPlan.length; index += 1) {
    if (isCancelled()) {
      throw new Error('The clip import was cancelled.')
    }

    const item = importPlan[index]
    const destinationPath = destinationForImport(item, cameraFolders)
    await fs.mkdir(path.dirname(destinationPath), { recursive: true })
    let copiedCurrentFile = false

    try {
      await pipeline(
        createReadStream(item.sourcePath),
        createWriteStream(destinationPath, { flags: 'wx' })
      )
      copiedCurrentFile = true
    } catch (error) {
      if (error.code === 'EEXIST') {
        skipped += 1
      } else {
        await fs.rm(destinationPath, { force: true })
        throw error
      }
    }

    if (copiedCurrentFile) {
      try {
        const stats = await fs.stat(item.sourcePath)
        await fs.utimes(destinationPath, stats.atime, stats.mtime)
        copied += 1
      } catch (error) {
        await fs.rm(destinationPath, { force: true })
        throw error
      }
    }

    onProgress({
      current: index + 1,
      total: importPlan.length,
      percent: Math.round(((index + 1) / importPlan.length) * 100)
    })
  }

  return { copied, skipped }
}

module.exports = {
  copyImportPlan,
  destinationForImport
}
