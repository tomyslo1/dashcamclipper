const fs = require('node:fs/promises')
const path = require('node:path')

const DEFAULT_TOOL_SETTINGS = {
  ffmpegPath: '',
  vlcPath: ''
}

function cleanToolSettings(value) {
  return {
    ffmpegPath: typeof value?.ffmpegPath === 'string' ? value.ffmpegPath : '',
    vlcPath: typeof value?.vlcPath === 'string' ? value.vlcPath : ''
  }
}

async function readToolSettings(userDataPath) {
  const settingsPath = path.join(userDataPath, 'settings.json')

  try {
    const contents = await fs.readFile(settingsPath, 'utf8')
    return cleanToolSettings(JSON.parse(contents))
  } catch {
    return { ...DEFAULT_TOOL_SETTINGS }
  }
}

async function writeToolSettings(userDataPath, settings) {
  const cleanSettings = cleanToolSettings(settings)
  const settingsPath = path.join(userDataPath, 'settings.json')
  await fs.mkdir(userDataPath, { recursive: true })
  await fs.writeFile(settingsPath, `${JSON.stringify(cleanSettings, null, 2)}\n`, 'utf8')
  return cleanSettings
}

module.exports = {
  cleanToolSettings,
  readToolSettings,
  writeToolSettings
}
