const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const test = require('node:test')

const {
  SEGMENT_GAP_MS,
  OUTLIER_DATE_GAP_MS,
  createClipRange,
  findOriginalClips,
  findOriginalClipsByKeys,
  filterClips,
  groupSegments,
  pairCameraFiles,
  parseClipNumber,
  reconcileClipTimeline,
  scanSource,
  sortClipsByName,
  toPublicSegment
} = require('../src/lib/clips')
const { setClipsProcessed } = require('../src/lib/processing-metadata')
const { copyImportPlan } = require('../src/lib/import-clips')

function cameraFile(name, time, camera) {
  return {
    path: `/${camera}/${name}`,
    name,
    relativeKey: name.toLowerCase(),
    baseKey: name.toLowerCase(),
    recordedAt: new Date(time),
    size: 100
  }
}

function clipAt(time) {
  const front = cameraFile(`${time}.avi`, time, 'front')
  return { recordedAt: front.recordedAt, front, rear: null, size: front.size }
}

function numberedClip(number, time) {
  const name = `MOVI${String(number).padStart(4, '0')}.avi`
  const front = cameraFile(name, time, 'front')
  front.relativePath = name
  return { recordedAt: front.recordedAt, front, rear: null, size: front.size }
}

test('pairs front and rear files with the same filename', () => {
  const front = [cameraFile('20260731_133100.avi', '2026-07-31T13:31:00', 'front')]
  const rear = [cameraFile('20260731_133100.avi', '2026-07-31T13:31:01', 'rear')]
  const result = pairCameraFiles(front, rear)

  assert.equal(result.clips[0].rear.path, rear[0].path)
  assert.equal(result.unpairedRearCount, 0)
})

test('uses a close timestamp when camera filenames differ', () => {
  const front = [cameraFile('front-1.avi', '2026-07-31T13:31:00', 'front')]
  const rear = [cameraFile('rear-1.avi', '2026-07-31T13:31:08', 'rear')]
  const result = pairCameraFiles(front, rear)

  assert.equal(result.clips[0].rear.path, rear[0].path)
})

test('starts a new segment after a gap longer than three minutes', () => {
  const clips = [
    clipAt('2026-07-31T13:31:00'),
    clipAt('2026-07-31T13:32:00'),
    clipAt('2026-07-31T14:02:00'),
    clipAt('2026-07-31T14:05:00'),
    clipAt('2026-07-31T14:30:00')
  ]
  const segments = groupSegments(clips, SEGMENT_GAP_MS)

  assert.equal(segments.length, 3)
  assert.equal(segments[0].clipCount, 2)
  assert.equal(segments[1].clipCount, 2)
  assert.equal(segments[2].clipCount, 1)
  assert.equal(segments[0].filenameDate.getTime(), clips[1].recordedAt.getTime())
})

test('reads the first and last numeric clip suffix for saved filenames', () => {
  const clips = [
    { front: { name: 'MOVI0094.avi' } },
    { front: { name: 'MOVI0106.avi' } }
  ]

  assert.equal(parseClipNumber('MOVI0094.avi'), 94)
  assert.deepEqual(createClipRange(clips), { start: 94, end: 106 })
})

test('finds every original front and rear file in a saved clip range', async (context) => {
  const rootPath = await fs.mkdtemp(path.join(process.cwd(), '.original-clips-test-'))
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }))
  await fs.mkdir(path.join(rootPath, 'DCIMA'), { recursive: true })
  await fs.mkdir(path.join(rootPath, 'DCIMB'), { recursive: true })

  for (const number of [94, 95, 96]) {
    const name = `MOVI${String(number).padStart(4, '0')}.avi`
    await fs.writeFile(path.join(rootPath, 'DCIMA', name), 'front')
    await fs.writeFile(path.join(rootPath, 'DCIMB', name), 'rear')
  }

  const clips = await findOriginalClips(rootPath, { start: 94, end: 96 })

  assert.deepEqual(clips.map((clip) => clip.front.name), [
    'MOVI0094.avi',
    'MOVI0095.avi',
    'MOVI0096.avi'
  ])
  assert.ok(clips.every((clip) => clip.rear))

  const savedRecipeClips = await findOriginalClipsByKeys(rootPath, ['movi0094.avi', 'movi0096.avi'])
  assert.deepEqual(savedRecipeClips.map((clip) => clip.front.name), ['MOVI0094.avi', 'MOVI0096.avi'])
})

test('refuses to rebuild a saved video when an original rear file is missing', async (context) => {
  const rootPath = await fs.mkdtemp(path.join(process.cwd(), '.original-clips-test-'))
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }))
  await fs.mkdir(path.join(rootPath, 'DCIMA'), { recursive: true })
  await fs.mkdir(path.join(rootPath, 'DCIMB'), { recursive: true })
  await fs.writeFile(path.join(rootPath, 'DCIMA', 'MOVI0094.avi'), 'front')

  await assert.rejects(
    () => findOriginalClips(rootPath, { start: 94, end: 94 }),
    /rear clip 94 is missing/i
  )
})

test('sorts segment clips naturally by filename instead of modification order', () => {
  const clips = [
    numberedClip(388, '2026-07-30T13:31:00Z'),
    numberedClip(389, '2026-07-30T13:34:00Z'),
    numberedClip(390, '2026-07-30T13:32:00Z'),
    numberedClip(391, '2026-07-30T13:33:00Z')
  ]
  const segments = groupSegments(clips)

  assert.deepEqual(segments[0].clips.map((clip) => clip.front.name), [
    'MOVI0388.avi',
    'MOVI0389.avi',
    'MOVI0390.avi',
    'MOVI0391.avi'
  ])
  assert.deepEqual(
    sortClipsByName([numberedClip(10, '2026-07-30T13:32:00Z'), numberedClip(9, '2026-07-30T13:31:00Z')])
      .map((clip) => clip.front.name),
    ['MOVI0009.avi', 'MOVI0010.avi']
  )
})

test('places a bad-date clip immediately before its consecutive successor', () => {
  const clips = [
    numberedClip(378, '2026-07-30T02:05:00Z'),
    numberedClip(379, '2026-07-03T02:07:00Z'),
    numberedClip(380, '2026-07-30T02:07:00Z'),
    numberedClip(381, '2026-07-30T02:08:00Z')
  ]
  const segments = groupSegments(clips)

  assert.equal(OUTLIER_DATE_GAP_MS, 12 * 60 * 60 * 1000)
  assert.equal(segments.length, 1)
  assert.deepEqual(segments[0].clips.map((clip) => clip.front.name), [
    'MOVI0378.avi',
    'MOVI0379.avi',
    'MOVI0380.avi',
    'MOVI0381.avi'
  ])
  assert.equal(clips[1].timelineAdjusted, true)
  assert.equal(clips[1].timelineAt.toISOString(), '2026-07-30T02:06:00.000Z')
  assert.equal(clips[1].recordedAt.toISOString(), '2026-07-03T02:07:00.000Z')
})

test('uses the inferred timeline when filtering a bad-date clip', () => {
  const clips = [
    numberedClip(379, '2026-07-03T02:07:00Z'),
    numberedClip(380, '2026-07-30T02:07:00Z'),
    numberedClip(381, '2026-07-30T02:08:00Z')
  ]
  reconcileClipTimeline(clips)
  const filtered = filterClips(clips, {
    mode: 'range',
    startDate: '2026-07-30',
    startTime: '02:00'
  })

  assert.equal(filtered.length, 3)
  assert.equal(filtered[0].front.name, 'MOVI0379.avi')
})

test('keeps an inferred time after a date filter removes an anchoring neighbor', () => {
  const clips = [
    numberedClip(379, '2026-07-03T02:07:00Z'),
    numberedClip(380, '2026-07-30T02:07:00Z'),
    numberedClip(381, '2026-07-30T02:08:00Z')
  ]
  reconcileClipTimeline(clips)
  const segments = groupSegments(clips.slice(0, 2))

  assert.equal(segments.length, 1)
  assert.equal(segments[0].clips[0].timelineAdjusted, true)
})

test('does not join ordinary consecutive filenames recorded days apart', () => {
  const clips = [
    numberedClip(378, '2026-07-03T02:06:00Z'),
    numberedClip(379, '2026-07-03T02:07:00Z'),
    numberedClip(380, '2026-07-30T02:07:00Z'),
    numberedClip(381, '2026-07-30T02:08:00Z')
  ]
  const segments = groupSegments(clips)

  assert.equal(segments.length, 2)
  assert.equal(clips[1].timelineAdjusted, false)
})

test('filters inclusively from the selected local date and time', () => {
  const clips = [
    clipAt('2026-07-31T13:30:00'),
    clipAt('2026-07-31T13:31:00'),
    clipAt('2026-07-31T14:02:00')
  ]
  const filtered = filterClips(clips, {
    mode: 'range',
    startDate: '2026-07-31',
    startTime: '13:31'
  })

  assert.equal(filtered.length, 2)
  assert.equal(filtered[0].recordedAt.getHours(), 13)
  assert.equal(filtered[0].recordedAt.getMinutes(), 31)
})

test('scans matching camera folders and returns public trip data', async (context) => {
  const rootPath = await fs.mkdtemp(path.join(process.cwd(), '.dashcam-test-'))
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }))
  const frontPath = path.join(rootPath, 'DCIMA')
  const rearPath = path.join(rootPath, 'DCIMB')
  await fs.mkdir(frontPath)
  await fs.mkdir(rearPath)

  for (const [name, time] of [
    ['one.avi', new Date(2026, 6, 31, 13, 31)],
    ['two.avi', new Date(2026, 6, 31, 13, 32)]
  ]) {
    const frontFile = path.join(frontPath, name)
    const rearFile = path.join(rearPath, name)
    await fs.writeFile(frontFile, '')
    await fs.writeFile(rearFile, '')
    await fs.utimes(frontFile, time, time)
    await fs.utimes(rearFile, time, time)
  }

  await setClipsProcessed(rootPath, ['one.avi'], true)
  const result = await scanSource(rootPath, { mode: 'all' })
  const publicSegment = toPublicSegment(result.segments[0])

  assert.equal(result.segments.length, 1)
  assert.equal(result.segments[0].clipCount, 2)
  assert.equal(result.segments[0].pairedCount, 2)
  assert.equal(result.segments[0].processedCount, 1)
  assert.equal(result.segments[0].processed, false)
  assert.equal(publicSegment.clips[0].processed, true)
  assert.equal(publicSegment.clips[1].processed, false)
  assert.equal(publicSegment.filenameDate, result.segments[0].clips[1].recordedAt.toISOString())
  assert.equal(result.totals.front, 2)
  assert.equal(result.totals.rear, 2)

  const shorterGapResult = await scanSource(rootPath, { mode: 'all' }, rootPath, 30 * 1000)
  assert.equal(shorterGapResult.segments.length, 2)
})

test('compares a removable source with server files and server metadata', async (context) => {
  const rootPath = await fs.mkdtemp(path.join(process.cwd(), '.dashcam-library-test-'))
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }))
  const sourcePath = path.join(rootPath, 'card')
  const libraryPath = path.join(rootPath, 'server')

  for (const cameraFolder of ['DCIMA', 'DCIMB']) {
    await fs.mkdir(path.join(sourcePath, cameraFolder), { recursive: true })
    await fs.mkdir(path.join(libraryPath, cameraFolder), { recursive: true })
  }

  for (const [name, time] of [
    ['Existing.AVI', new Date(2026, 6, 31, 13, 31)],
    ['NewClip.AVI', new Date(2026, 6, 31, 13, 32)]
  ]) {
    for (const cameraFolder of ['DCIMA', 'DCIMB']) {
      const sourceFile = path.join(sourcePath, cameraFolder, name)
      await fs.writeFile(sourceFile, name)
      await fs.utimes(sourceFile, time, time)
    }
  }

  for (const cameraFolder of ['DCIMA', 'DCIMB']) {
    const libraryFile = path.join(libraryPath, cameraFolder, 'Existing.AVI')
    const existingTime = new Date(2026, 6, 31, 13, 31)
    await fs.writeFile(libraryFile, 'Existing.AVI')
    await fs.utimes(libraryFile, existingTime, existingTime)
  }

  await setClipsProcessed(libraryPath, ['existing.avi'], true)
  const result = await scanSource(sourcePath, { mode: 'all' }, libraryPath)

  assert.equal(result.sourceIsLibrary, false)
  assert.equal(result.importPlan.length, 2)
  assert.equal(result.totals.newFront, 1)
  assert.equal(result.totals.newRear, 1)
  assert.ok(result.importPlan.every((item) => item.relativePath === 'NewClip.AVI'))
  assert.equal(result.segments[0].processedCount, 1)
  assert.equal(result.segments[0].newClipCount, 1)
  assert.equal(await fs.access(path.join(sourcePath, 'dashcamclipper')).then(() => true).catch(() => false), false)
  assert.equal(await fs.access(path.join(libraryPath, 'dashcamclipper', 'metadata.json')).then(() => true).catch(() => false), true)
})

test('imports reused MOVI filenames into a new server subfolder without overwriting', async (context) => {
  const rootPath = await fs.mkdtemp(path.join(process.cwd(), '.dashcam-collision-test-'))
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }))
  const sourcePath = path.join(rootPath, 'card')
  const libraryPath = path.join(rootPath, 'server')
  const oldTime = new Date(2026, 6, 1, 10, 0)
  const newTime = new Date(2026, 7, 8, 14, 0)

  for (const cameraFolder of ['DCIMA', 'DCIMB']) {
    const sourceFolder = path.join(sourcePath, cameraFolder)
    const libraryFolder = path.join(libraryPath, cameraFolder)
    await fs.mkdir(sourceFolder, { recursive: true })
    await fs.mkdir(libraryFolder, { recursive: true })
    const sourceFile = path.join(sourceFolder, 'MOVI0001.avi')
    const libraryFile = path.join(libraryFolder, 'MOVI0001.avi')
    await fs.writeFile(sourceFile, 'new card recording')
    await fs.utimes(sourceFile, newTime, newTime)
    await fs.writeFile(libraryFile, 'old card recording')
    await fs.utimes(libraryFile, oldTime, oldTime)
  }

  const firstScan = await scanSource(sourcePath, { mode: 'all' }, libraryPath)

  assert.equal(firstScan.importPlan.length, 2)
  assert.ok(firstScan.importPlan.every((item) => item.relativePath.startsWith('Imports/')))
  assert.equal(firstScan.importPlan[0].relativePath, firstScan.importPlan[1].relativePath)
  await copyImportPlan(firstScan.importPlan, {
    frontPath: firstScan.libraryFrontPath,
    rearPath: firstScan.libraryRearPath
  })

  const secondScan = await scanSource(sourcePath, { mode: 'all' }, libraryPath)
  assert.equal(secondScan.importPlan.length, 0)
  assert.equal(await fs.readFile(path.join(libraryPath, 'DCIMA', 'MOVI0001.avi'), 'utf8'), 'old card recording')
  assert.equal(
    await fs.readFile(path.join(libraryPath, 'DCIMA', firstScan.importPlan[0].relativePath), 'utf8'),
    'new card recording'
  )
})
