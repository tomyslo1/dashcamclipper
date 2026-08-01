const assert = require('node:assert/strict')
const test = require('node:test')

const {
  buildMergeArguments,
  buildThumbnailArguments,
  formatFilenameDate,
  parseProgressLine,
  sanitizeClipName
} = require('../src/lib/media')

test('builds paired vstack and concat filters without shell quoting', () => {
  const clips = [
    { front: { path: 'C:\\front\\one.avi' }, rear: { path: 'C:\\rear\\one.avi' } },
    { front: { path: 'C:\\front\\two.avi' }, rear: { path: 'C:\\rear\\two.avi' } }
  ]
  const args = buildMergeArguments(clips, 'output.mp4', ['-c:v', 'libx265'])
  const filter = args[args.indexOf('-filter_complex') + 1]

  assert.match(filter, /\[0:v\]\[1:v\]vstack=inputs=2\[v0\]/)
  assert.match(filter, /\[v0\]\[0:a\]\[v1\]\[2:a\]concat=n=2:v=1:a=1\[outv\]\[outa\]/)
  assert.ok(args.includes('C:\\front\\one.avi'))
})

test('cleans names that are unsafe on Windows and macOS', () => {
  assert.equal(sanitizeClipName('  Close: call / home?  '), 'Close_ call _ home_')
})

test('formats the required archive filename timestamp', () => {
  assert.equal(formatFilenameDate(new Date(2026, 6, 31, 13, 31)), '2026-07-31_13-31')
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
