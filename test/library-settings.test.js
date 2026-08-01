const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const test = require('node:test')

const {
  cleanLibrarySettings,
  readLibrarySettings,
  writeLibrarySettings
} = require('../src/lib/library-settings')

test('cleans invalid server library settings', () => {
  assert.deepEqual(cleanLibrarySettings({ libraryPath: 42 }), { libraryPath: '' })
  assert.deepEqual(cleanLibrarySettings({ libraryPath: 'Y:\\Dashcam' }), { libraryPath: 'Y:\\Dashcam' })
})

test('persists the server library path', async (context) => {
  const userDataPath = await fs.mkdtemp(path.join(process.cwd(), '.library-test-'))
  context.after(() => fs.rm(userDataPath, { recursive: true, force: true }))

  await writeLibrarySettings(userDataPath, { libraryPath: 'Y:\\Dashcam' })

  assert.deepEqual(await readLibrarySettings(userDataPath), { libraryPath: 'Y:\\Dashcam' })
})
