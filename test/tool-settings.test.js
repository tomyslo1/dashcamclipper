const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const test = require('node:test')

const {
  cleanToolSettings,
  readToolSettings,
  writeToolSettings
} = require('../src/lib/tool-settings')

test('keeps only supported executable path settings', () => {
  assert.deepEqual(cleanToolSettings({
    ffmpegPath: 'C:\\Tools\\ffmpeg.exe',
    vlcPath: 42,
    unrelated: true
  }), {
    ffmpegPath: 'C:\\Tools\\ffmpeg.exe',
    vlcPath: ''
  })
})

test('persists and reloads selected external tools', async (context) => {
  const userDataPath = await fs.mkdtemp(path.join(process.cwd(), '.settings-test-'))
  context.after(() => fs.rm(userDataPath, { recursive: true, force: true }))
  const expected = {
    ffmpegPath: 'C:\\Tools\\ffmpeg.exe',
    vlcPath: 'C:\\Tools\\vlc.exe'
  }

  await writeToolSettings(userDataPath, expected)

  assert.deepEqual(await readToolSettings(userDataPath), expected)
})

test('uses automatic detection defaults when no settings file exists', async (context) => {
  const userDataPath = await fs.mkdtemp(path.join(process.cwd(), '.settings-test-'))
  context.after(() => fs.rm(userDataPath, { recursive: true, force: true }))

  assert.deepEqual(await readToolSettings(userDataPath), {
    ffmpegPath: '',
    vlcPath: ''
  })
})
