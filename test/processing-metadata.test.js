const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const test = require('node:test')

const {
  clearProcessedClips,
  getSavedVideoRecipe,
  metadataPaths,
  readProcessingMetadata,
  setClipsProcessed,
  setSavedVideoRecipe
} = require('../src/lib/processing-metadata')

async function createSource(context) {
  const rootPath = await fs.mkdtemp(path.join(process.cwd(), '.metadata-test-'))
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }))
  return rootPath
}

test('creates source-local metadata on the first read', async (context) => {
  const rootPath = await createSource(context)
  const metadata = await readProcessingMetadata(rootPath)
  const paths = metadataPaths(rootPath)

  assert.deepEqual(metadata.processedClips, {})
  assert.deepEqual(metadata.savedVideos, {})
  assert.equal(path.basename(paths.directoryPath), 'dashcamclipper')
  assert.equal(path.basename(paths.filePath), 'metadata.json')
  assert.equal(JSON.parse(await fs.readFile(paths.filePath, 'utf8')).version, 2)
})

test('clears processed history without deleting saved video recipes', async (context) => {
  const rootPath = await createSource(context)
  const fileName = '2026-08-08_14-00 Drive.mp4'
  await setClipsProcessed(rootPath, ['Imports/card/MOVI0001.avi'], true)
  await setSavedVideoRecipe(rootPath, fileName, ['Imports/card/MOVI0001.avi'])

  const metadata = await clearProcessedClips(rootPath)
  const recipe = await getSavedVideoRecipe(rootPath, fileName)

  assert.deepEqual(metadata.processedClips, {})
  assert.deepEqual(recipe.clipKeys, ['imports/card/movi0001.avi'])
})

test('marks individual clips processed and unprocessed', async (context) => {
  const rootPath = await createSource(context)

  await setClipsProcessed(rootPath, ['Trip/ONE.AVI', 'two.avi'], true)
  let metadata = await readProcessingMetadata(rootPath)

  assert.equal(typeof metadata.processedClips['trip/one.avi'], 'string')
  assert.equal(typeof metadata.processedClips['two.avi'], 'string')

  await setClipsProcessed(rootPath, ['trip/one.avi'], false)
  metadata = await readProcessingMetadata(rootPath)

  assert.equal(metadata.processedClips['trip/one.avi'], undefined)
  assert.equal(typeof metadata.processedClips['two.avi'], 'string')
})

test('does not silently replace invalid metadata', async (context) => {
  const rootPath = await createSource(context)
  const paths = metadataPaths(rootPath)
  await fs.mkdir(paths.directoryPath)
  await fs.writeFile(paths.filePath, '{invalid', 'utf8')

  await assert.rejects(
    readProcessingMetadata(rootPath),
    /is not valid JSON/
  )
})
