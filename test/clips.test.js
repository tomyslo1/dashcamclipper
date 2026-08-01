const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const test = require('node:test')

const {
  SEGMENT_GAP_MS,
  filterClips,
  groupSegments,
  pairCameraFiles,
  scanSource,
  toPublicSegment
} = require('../src/lib/clips')
const { setClipsProcessed } = require('../src/lib/processing-metadata')

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
  assert.equal(result.totals.front, 2)
  assert.equal(result.totals.rear, 2)
})
