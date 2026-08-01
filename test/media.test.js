const assert = require('node:assert/strict')
const test = require('node:test')

const {
  applyFilenameDateOverrides,
  buildMergeArguments,
  buildProcessedFilename,
  buildThumbnailArguments,
  extractProcessedClipName,
  formatFilenameDate,
  parseProgressLine,
  rankProcessedClipNames,
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

test('converts FFmpeg microsecond progress into a percentage', () => {
  assert.equal(parseProgressLine('out_time_ms=30000000', 60), 50)
})

test('builds a small front-camera thumbnail command', () => {
  const args = buildThumbnailArguments('front clip.avi', 'preview.jpg')

  assert.deepEqual(args.slice(0, 5), ['-y', '-ss', '0.25', '-i', 'front clip.avi'])
  assert.ok(args.includes('scale=320:-2'))
  assert.equal(args.at(-1), 'preview.jpg')
})
