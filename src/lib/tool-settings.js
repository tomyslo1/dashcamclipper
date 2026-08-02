const fs = require('node:fs/promises')
const path = require('node:path')

const DEFAULT_TOOL_SETTINGS = {
  ffmpegPath: '',
  vlcPath: '',
  theme: 'auto',
  mirrorRear: true,
  segmentGapMinutes: 3,
  checkForUpdates: true,
  thumbnailPreviews: true
}

function cleanToolSettings(value) {
  const theme = ['auto', 'light', 'dark'].includes(value?.theme) ? value.theme : 'auto'
  const requestedGap = Number(value?.segmentGapMinutes)
  const segmentGapMinutes = Number.isFinite(requestedGap)
    ? Math.min(60, Math.max(1, Math.round(requestedGap)))
    : 3

  return {
    ffmpegPath: typeof value?.ffmpegPath === 'string' ? value.ffmpegPath : '',
    vlcPath: typeof value?.vlcPath === 'string' ? value.vlcPath : '',
    theme,
    mirrorRear: typeof value?.mirrorRear === 'boolean' ? value.mirrorRear : true,
    segmentGapMinutes,
    checkForUpdates: typeof value?.checkForUpdates === 'boolean' ? value.checkForUpdates : true,
    thumbnailPreviews: typeof value?.thumbnailPreviews === 'boolean' ? value.thumbnailPreviews : true
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
