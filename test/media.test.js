const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  applyFilenameDateOverrides,
  buildFrontAudioPlaylist,
  buildDateMetadataArguments,
  buildMergeArguments,
  buildProcessedFilename,
  buildThumbnailArguments,
  buildTrimArguments,
  dateFromProcessedVideoFilename,
  defaultFfmpegCandidates,
  extractProcessedClipName,
  formatFilenameDate,
  listProcessedVideos,
  parseProgressLine,
  parseProcessedVideoFilename,
  processedVideoPath,
  rankProcessedClipNames,
  replaceVideoFile,
  selectEncoder,
  sanitizeClipName
} = require('../src/lib/media')

test('mirrors the rear image above its bottom 50 pixels by default', () => {
  const clips = [
    { front: { path: 'C:\\front\\one.avi' }, rear: { path: 'C:\\rear\\one.avi' } },
    { front: { path: 'C:\\front\\two.avi' }, rear: { path: 'C:\\rear\\two.avi' } }
  ]
  const args = buildMergeArguments(clips, 'output.mp4', ['-c:v', 'libx265'], {
    frontAudioPlaylistPath: 'front-audio.ffconcat'
  })
  const filter = args[args.indexOf('-filter_complex') + 1]

  assert.match(filter, /\[1:v\]split=2\[rearBase0\]\[rearFlip0\]/)
  assert.match(filter, /\[rearFlip0\]crop=iw:ih-50:0:0,hflip\[rearMain0\]/)
  assert.match(filter, /\[rearBase0\]\[rearMain0\]overlay=0:0\[rear0\]/)
  assert.match(filter, /\[0:v\]\[rear0\]vstack=inputs=2\[v0\]/)
  assert.match(filter, /\[v0\]\[v1\]concat=n=2:v=1:a=0\[outv\]/)
  assert.equal(args[args.indexOf('-c:a') + 1], 'copy')
  assert.equal(args[args.indexOf('-map', args.indexOf('-map') + 1) + 1], '4:a:0')
  assert.equal(args.includes('[outa]'), false)
  assert.equal(args.includes('64k'), false)
  assert.ok(args.includes('C:\\front\\one.avi'))
})

test('can stack the rear image without mirroring it', () => {
  const clips = [
    { front: { path: 'front.avi' }, rear: { path: 'rear.avi' } }
  ]
  const args = buildMergeArguments(clips, 'output.mp4', [], {
    mirrorRear: false,
    frontAudioPlaylistPath: 'front-audio.ffconcat'
  })
  const filter = args[args.indexOf('-filter_complex') + 1]

  assert.match(filter, /\[0:v\]\[1:v\]vstack=inputs=2\[v0\]/)
  assert.doesNotMatch(filter, /hflip/)
})

test('orders FFmpeg inputs naturally by clip filename', () => {
  const clips = [
    { front: { name: 'MOVI0391.avi', path: 'front-391.avi' }, rear: { path: 'rear-391.avi' } },
    { front: { name: 'MOVI0390.avi', path: 'front-390.avi' }, rear: { path: 'rear-390.avi' } }
  ]
  const args = buildMergeArguments(clips, 'output.mp4', ['-c:v', 'libx265'], {
    frontAudioPlaylistPath: 'front-audio.ffconcat'
  })

  assert.ok(args.indexOf('front-390.avi') < args.indexOf('front-391.avi'))
})

test('builds a naturally ordered playlist from front-camera files only', () => {
  const clips = [
    {
      front: { name: 'MOVI0391.avi', path: "clips/Driver's/MOVI0391.avi" },
      rear: { name: 'MOVI0391.avi', path: 'rear/MOVI0391.avi' }
    },
    {
      front: { name: 'MOVI0390.avi', path: "clips/Driver's/MOVI0390.avi" },
      rear: { name: 'MOVI0390.avi', path: 'rear/MOVI0390.avi' }
    }
  ]
  const playlist = buildFrontAudioPlaylist(clips)

  assert.ok(playlist.startsWith('ffconcat version 1.0'))
  assert.ok(playlist.indexOf('MOVI0390.avi') < playlist.indexOf('MOVI0391.avi'))
  assert.equal(playlist.includes('rear/MOVI0390.avi'), false)
  assert.ok(playlist.includes("Driver'\\''s"))
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
  assert.equal(encoder.args[encoder.args.indexOf('-b:v') + 1], '4500k')
  assert.equal(encoder.args[encoder.args.indexOf('-maxrate') + 1], '7000k')
  assert.equal(encoder.args.includes('-q:v'), false)
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

test('reads a local date and time from a processed filename', () => {
  const date = dateFromProcessedVideoFilename('2026-08-01_08-48 Mercator (388 - 398).mp4')

  assert.equal(date.getFullYear(), 2026)
  assert.equal(date.getMonth(), 7)
  assert.equal(date.getDate(), 1)
  assert.equal(date.getHours(), 8)
  assert.equal(date.getMinutes(), 48)
  assert.equal(dateFromProcessedVideoFilename('Mercator.mp4'), null)
})

test('embeds the filename date while stream-copying a trimmed video', () => {
  const date = new Date(2026, 7, 1, 8, 48)
  const args = buildTrimArguments('merged.mp4', 'saved.mp4', 2.5, 30, date)

  assert.equal(args[args.indexOf('-c') + 1], 'copy')
  assert.ok(args.includes(`creation_time=${date.toISOString()}`))
  assert.equal(args[args.indexOf('-map_metadata') + 1], '0')
})

test('builds a stream-copy command for applying a filename date', () => {
  const date = new Date(2026, 7, 1, 8, 48)
  const args = buildDateMetadataArguments('existing.mp4', 'updated.mp4', date)

  assert.equal(args[args.indexOf('-c') + 1], 'copy')
  assert.equal(args[args.indexOf('-map') + 1], '0')
  assert.ok(args.includes(`creation_time=${date.toISOString()}`))
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

test('reads display details from a processed video filename', () => {
  assert.deepEqual(
    parseProcessedVideoFilename('2026-08-01_08-48 Mercator (388 - 398).mp4'),
    {
      title: 'Mercator',
      recordedAt: {
        year: 2026,
        month: 8,
        day: 1,
        hours: 8,
        minutes: 48
      },
      clipRange: { start: 388, end: 398 }
    }
  )
  assert.equal(parseProcessedVideoFilename('2026-02-31_08-48 Invalid.mp4'), null)
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
    assert.equal(videos[0].title, 'Shop')
    assert.deepEqual(videos[0].recordedAt, {
      year: 2026,
      month: 7,
      day: 30,
      hours: 15,
      minutes: 10
    })
    assert.deepEqual(videos[0].clipRange, { start: 94, end: 106 })
    assert.ok(videos[0].modifiedAt)
  } finally {
    await fs.rm(folder, { recursive: true, force: true })
  }
})

test('rejects paths outside the saved video folder', () => {
  assert.throws(() => processedVideoPath('../other.mp4'), /saved MP4 video/i)
  assert.throws(() => processedVideoPath('other.mov'), /saved MP4 video/i)
})

test('installs a completed replacement without leaving the old saved file beside it', async (context) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'dashcam-replace-'))
  context.after(() => fs.rm(folder, { recursive: true, force: true }))
  const savedPath = path.join(folder, 'saved.mp4')
  const replacementPath = path.join(folder, 'replacement.mp4')
  await fs.writeFile(savedPath, 'old video')
  await fs.writeFile(replacementPath, 'new video')

  await replaceVideoFile(savedPath, replacementPath)

  assert.equal(await fs.readFile(savedPath, 'utf8'), 'new video')
  assert.equal(await fs.access(replacementPath).then(() => true).catch(() => false), false)
  assert.deepEqual(await fs.readdir(folder), ['saved.mp4'])
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

test('checks common Homebrew FFmpeg locations on macOS', () => {
  const candidates = defaultFfmpegCandidates('darwin', {})

  assert.ok(candidates.includes('/opt/homebrew/bin/ffmpeg'))
  assert.ok(candidates.includes('/usr/local/bin/ffmpeg'))
  assert.ok(candidates.includes('/opt/local/bin/ffmpeg'))
})
