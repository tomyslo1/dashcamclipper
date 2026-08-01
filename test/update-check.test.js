const assert = require('node:assert/strict')
const test = require('node:test')

const {
  buildUpdateStatus,
  isNewerVersion,
  isReleaseUrl,
  parseVersion
} = require('../src/lib/update-check')

test('parses release tags and compares version numbers', () => {
  assert.deepEqual(parseVersion('v1.2.3'), [1, 2, 3])
  assert.equal(isNewerVersion('0.2.0', '0.1.9'), true)
  assert.equal(isNewerVersion('0.1.1', '0.1.1'), false)
  assert.equal(isNewerVersion('0.1.0', '0.1.1'), false)
})

test('accepts only Dashcam Clipper GitHub release links', () => {
  assert.equal(isReleaseUrl('https://github.com/tomyslo1/dashcamclipper/releases/tag/v0.2.0'), true)
  assert.equal(isReleaseUrl('https://example.com/tomyslo1/dashcamclipper/releases/tag/v0.2.0'), false)
})

test('shows an update only for a newer valid release', () => {
  const status = buildUpdateStatus('0.1.1', {
    tag_name: 'v0.2.0',
    html_url: 'https://github.com/tomyslo1/dashcamclipper/releases/tag/v0.2.0'
  })

  assert.deepEqual(status, {
    available: true,
    currentVersion: '0.1.1',
    latestVersion: '0.2.0',
    releaseUrl: 'https://github.com/tomyslo1/dashcamclipper/releases/tag/v0.2.0'
  })
  assert.equal(buildUpdateStatus('0.2.0', {
    tag_name: 'v0.2.0',
    html_url: 'https://github.com/tomyslo1/dashcamclipper/releases/tag/v0.2.0'
  }).available, false)
})
