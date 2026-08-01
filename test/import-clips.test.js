const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const test = require('node:test')

const {
  copyImportPlan,
  destinationForImport
} = require('../src/lib/import-clips')

test('copies new clips without overwriting server files', async (context) => {
  const rootPath = await fs.mkdtemp(path.join(process.cwd(), '.import-test-'))
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }))
  const sourcePath = path.join(rootPath, 'source')
  const frontPath = path.join(rootPath, 'library', 'DCIMA')
  const rearPath = path.join(rootPath, 'library', 'DCIMB')
  await fs.mkdir(sourcePath, { recursive: true })
  await fs.mkdir(frontPath, { recursive: true })
  await fs.mkdir(rearPath, { recursive: true })
  const existingSource = path.join(sourcePath, 'Existing.AVI')
  const newSource = path.join(sourcePath, 'New.AVI')
  await fs.writeFile(existingSource, 'card version')
  await fs.writeFile(newSource, 'new rear clip')
  const recordedAt = new Date(2026, 6, 31, 13, 31)
  await fs.utimes(newSource, recordedAt, recordedAt)
  await fs.writeFile(path.join(frontPath, 'Existing.AVI'), 'server version')

  const result = await copyImportPlan([
    { camera: 'front', sourcePath: existingSource, relativePath: 'Existing.AVI' },
    { camera: 'rear', sourcePath: newSource, relativePath: 'Nested/New.AVI' }
  ], { frontPath, rearPath })

  assert.deepEqual(result, { copied: 1, skipped: 1 })
  assert.equal(await fs.readFile(path.join(frontPath, 'Existing.AVI'), 'utf8'), 'server version')
  const importedPath = path.join(rearPath, 'Nested', 'New.AVI')
  assert.equal(await fs.readFile(importedPath, 'utf8'), 'new rear clip')
  assert.ok(Math.abs((await fs.stat(importedPath)).mtime - recordedAt) < 1000)
})

test('rejects import paths that escape the camera folder', () => {
  assert.throws(() => destinationForImport({
    camera: 'front',
    relativePath: '../outside.avi'
  }, {
    frontPath: 'C:\\Library\\DCIMA',
    rearPath: 'C:\\Library\\DCIMB'
  }), /invalid relative path/)
})

test('rejects unknown camera destinations', () => {
  assert.throws(() => destinationForImport({
    camera: 'side',
    relativePath: 'clip.avi'
  }, {
    frontPath: 'C:\\Library\\DCIMA',
    rearPath: 'C:\\Library\\DCIMB'
  }), /invalid camera type/)
})
