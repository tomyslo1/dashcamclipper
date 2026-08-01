const fs = require('node:fs/promises')
const path = require('node:path')

function cleanLibrarySettings(value) {
  return {
    libraryPath: typeof value?.libraryPath === 'string' ? value.libraryPath : ''
  }
}

async function readLibrarySettings(userDataPath) {
  const settingsPath = path.join(userDataPath, 'library.json')

  try {
    const contents = await fs.readFile(settingsPath, 'utf8')
    return cleanLibrarySettings(JSON.parse(contents))
  } catch {
    return cleanLibrarySettings()
  }
}

async function writeLibrarySettings(userDataPath, settings) {
  const cleanSettings = cleanLibrarySettings(settings)
  const settingsPath = path.join(userDataPath, 'library.json')
  await fs.mkdir(userDataPath, { recursive: true })
  await fs.writeFile(settingsPath, `${JSON.stringify(cleanSettings, null, 2)}\n`, 'utf8')
  return cleanSettings
}

module.exports = {
  cleanLibrarySettings,
  readLibrarySettings,
  writeLibrarySettings
}
