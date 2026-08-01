const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  applyFilenameDateOverrides,
  buildMergeArguments,
  buildProcessedFilename,
  buildThumbnailArguments,
  extractProcessedClipName,
  formatFilenameDate,
  listProcessedVideos,
  parseProgressLine,
  processedVideoPath,
  rankProcessedClipNames,
  selectEncoder,
  sanitizeClipName
} = require('../src/lib/media')

test('mirrors the rear image above its bottom 50 pixels by default', () => {
  const clips = [
    { front: { path: 'C:\\front\\one.avi' }, rear: { path: 'C:\\rear\\one.avi' } },
    { front: { path: 'C:\\front\\two.avi' }, rear: { path: 'C:\\rear\\two.avi' } }
  ]
  const args = buildMergeArguments(clips, 'output.mp4', ['-c:v', 'libx265'])
  const filter = args[args.indexOf('-filter_complex') + 1]

  assert.match(filter, /\[1:v\]split=2\[rearBase0\]\[rearFlip0\]/)
  assert.match(filter, /\[rearFlip0\]crop=iw:ih-50:0:0,hflip\[rearMain0\]/)
  assert.match(filter, /\[rearBase0\]\[rearMain0\]overlay=0:0\[rear0\]/)
  assert.match(filter, /\[0:v\]\[rear0\]vstack=inputs=2\[v0\]/)
  assert.match(filter, /\[v0\]\[0:a\]\[v1\]\[2:a\]concat=n=2:v=1:a=1\[outv\]\[outa\]/)
  assert.ok(args.includes('C:\\front\\one.avi'))
})

test('can stack the rear image without mirroring it', () => {
  const clips = [
    { front: { path: 'front.avi' }, rear: { path: 'rear.avi' } }
  ]
  const args = buildMergeArguments(clips, 'output.mp4', [], { mirrorRear: false })
  const filter = args[args.indexOf('-filter_complex') + 1]

  assert.match(filter, /\[0:v\]\[1:v\]vstack=inputs=2\[v0\]/)
  assert.doesNotMatch(filter, /hflip/)
})

test('orders FFmpeg inputs naturally by clip filename', () => {
  const clips = [
    { front: { name: 'MOVI0391.avi', path: 'front-391.avi' }, rear: { path: 'rear-391.avi' } },
    { front: { name: 'MOVI0390.avi', path: 'front-390.avi' }, rear: { path: 'rear-390.avi' } }
  ]
  const args = buildMergeArguments(clips, 'output.mp4', ['-c:v', 'libx265'])

  assert.ok(args.indexOf('front-390.avi') < args.indexOf('front-391.avi'))
})

test('uses available Windows HEVC hardware and falls back to CPU HEVC', () => {
  const encoders = 'hevc_nvenc hevc_amf hevc_qsv hevc_mf libx265 libx264'
  const amd = selectEncoder(encoders, 'win32', 'x64', (args) => !args.includes('hevc_nvenc'))
  const intel = selectEncoder(encoders, 'win32', 'x64', (args) => args.includes('hevc_qsv'))
  const mediaFoundation = selectEncoder('hevc_mf libx265', 'win32', 'x64', (args) => args.includes('hevc_mf'))
  const cpu = selectEncoder(encoders, 'win32', 'x64', (args) => args.includes('libx265'))

  assert.equal(amd.name, 'AMD AMF HEVC')
  assert.equal(intel.name, 'Intel Quick Sync HEVC')
  assert.equal(mediaFoundation.name, 'Windows Media Foundation hardware HEVC')
  assert.equal(cpu.name, 'software HEVC')
  assert.ok(cpu.args.includes('libx265'))
})

test('prefers VideoToolbox HEVC on Apple Silicon', () => {
  const encoder = selectEncoder('hevc_videotoolbox libx265', 'darwin', 'arm64', () => true)

  assert.equal(encoder.name, 'Apple Silicon VideoToolbox HEVC')
  assert.ok(encoder.args.includes('hevc_videotoolbox'))
})

test('does not silently fall back to H.264 when HEVC is unavailable', () => {
  assert.throws(
    () => selectEncoder('libx264', 'win32', 'x64', () => true),
    /usable HEVC encoder/i
  )
})

test('cleans names that are unsafe on Windows and macOS', () => {
  assert.equal(sanitizeClipName('  Close: call / home?  '), 'Close_ call _ home_')
})

test('formats the required archive filename timestamp', () => {
  assert.equal(formatFilenameDate(new Date(2026, 6, 31, 13, 31)), '2026-07-31_13-31')
  assert.equal(
    buildProcessedFilename(new Date(2026, 6, 30, 15, 10), 'Mercator', { start: 94, end: 106 }),
    '2026-07-30_15-10 Mercator (94 - 106).mp4'
  )
})

test('overrides filename date and time independently', () => {
  const automaticDate = new Date(2026, 6, 30, 15, 10, 42)

  assert.equal(
    formatFilenameDate(applyFilenameDateOverrides(automaticDate, '2026-08-02', '')),
    '2026-08-02_15-10'
  )
  assert.equal(
    formatFilenameDate(applyFilenameDateOverrides(automaticDate, '', '09:45')),
    '2026-07-30_09-45'
  )
  assert.equal(
    formatFilenameDate(applyFilenameDateOverrides(automaticDate, '2026-08-02', '09:45')),
    '2026-08-02_09-45'
  )
  assert.throws(() => applyFilenameDateOverrides(automaticDate, '2026-02-31', ''), /filename date is invalid/i)
})

test('finds and ranks reusable names in processed MP4 filenames', () => {
  const filenames = [
    '2026-07-30_15-10 Mercator (94 - 106).mp4',
    '2026-07-29_12-00 Home (40 - 45).mp4',
    '2026-07-28_09-15 mercator (20 - 24).mp4',
    '2026-07-27_08-10 Work (12).mp4',
    'notes.mp4',
    '2026-07-26_14-00 Ignored (1 - 2).mov'
  ]

  assert.equal(extractProcessedClipName(filenames[0]), 'Mercator')
  assert.deepEqual(rankProcessedClipNames(filenames), ['Mercator', 'Home', 'Work'])
})

test('lists saved MP4 videos in reverse filename order', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'dashcam-processed-'))

  try {
    await fs.writeFile(path.join(folder, '2026-07-30_15-10 Shop (94 - 106).mp4'), 'newer')
    await fs.writeFile(path.join(folder, '2026-07-29_12-00 Home (40 - 45).mp4'), 'older')
    await fs.writeFile(path.join(folder, 'notes.txt'), 'ignored')
    const videos = await listProcessedVideos(folder)

    assert.deepEqual(videos.map((video) => video.name), [
      '2026-07-30_15-10 Shop (94 - 106).mp4',
      '2026-07-29_12-00 Home (40 - 45).mp4'
    ])
    assert.equal(videos[0].size, 5)
    assert.ok(videos[0].modifiedAt)
  } finally {
    await fs.rm(folder, { recursive: true, force: true })
  }
})

test('rejects paths outside the saved video folder', () => {
  assert.throws(() => processedVideoPath('../other.mp4'), /saved MP4 video/i)
  assert.throws(() => processedVideoPath('other.mov'), /saved MP4 video/i)
})

test('converts FFmpeg microsecond progress into a percentage', () => {
  assert.equal(parseProgressLine('out_time_ms=30000000', 60), 50)
})

test('builds a small front-camera thumbnail command', () => {
  const args = buildThumbnailArguments('front clip.avi', 'preview.jpg')

  assert.deepEqual(args.slice(0, 5), ['-y', '-ss', '0.25', '-i', 'front clip.avi'])
  assert.ok(args.includes('scale=320:-2'))
  assert.equal(args.at(-1), 'preview.jpg')
})
