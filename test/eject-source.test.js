const assert = require('node:assert/strict')
const test = require('node:test')

const {
  ejectSource,
  macVolumeRoot,
  pathsMatch,
  windowsDriveRoot
} = require('../src/lib/eject-source')

test('finds removable volume roots without treating network paths as drives', () => {
  assert.equal(windowsDriveRoot('E:\\DCIMA'), 'E:\\')
  assert.equal(windowsDriveRoot('\\\\server\\dashcam\\DCIMA'), null)
  assert.equal(macVolumeRoot('/Volumes/DASHCAM/DCIMA'), '/Volumes/DASHCAM')
  assert.equal(macVolumeRoot('/Users/tomy/Dashcam/DCIMA'), null)
})

test('compares Windows paths without case sensitivity', () => {
  assert.equal(pathsMatch('Y:\\Videos\\Dashcam', 'y:\\videos\\dashcam\\', 'win32'), true)
  assert.equal(pathsMatch('/Volumes/card', '/Volumes/cloud', 'darwin'), false)
})

test('does not eject when the source is the server library', async () => {
  let commands = 0
  const result = await ejectSource('Y:\\Dashcam', 'y:\\dashcam\\', {
    platform: 'win32',
    execute: async () => {
      commands += 1
      return { stdout: '', stderr: '' }
    }
  })

  assert.equal(result.requested, false)
  assert.equal(commands, 0)
})

test('uses the Windows safe eject command for an external drive', async () => {
  const calls = []
  const result = await ejectSource('E:\\', 'Y:\\Videos\\Dashcam', {
    platform: 'win32',
    execute: async (command, args) => {
      calls.push({ command, args })
      return { stdout: 'ejected', stderr: '' }
    }
  })

  assert.equal(result.ejected, true)
  assert.equal(calls[0].command, 'powershell.exe')
  assert.ok(calls[0].args.at(-1).includes("$letter = 'E'"))
})

test('checks a macOS volume before asking diskutil to eject it', async () => {
  const calls = []
  const result = await ejectSource('/Volumes/DASHCAM', '/Volumes/cloud/Videos/Dashcam', {
    platform: 'darwin',
    execute: async (command, args) => {
      calls.push({ command, args })

      if (args[0] === 'info') {
        return {
          stdout: 'Device Location: External\nRemovable Media: Removable\nEjectable: Yes\n',
          stderr: ''
        }
      }

      return { stdout: 'Disk ejected', stderr: '' }
    }
  })

  assert.equal(result.ejected, true)
  assert.deepEqual(calls.map((call) => call.args), [
    ['info', '/Volumes/DASHCAM'],
    ['eject', '/Volumes/DASHCAM']
  ])
})

test('leaves a non-external macOS volume mounted', async () => {
  let commands = 0
  const result = await ejectSource('/Volumes/LocalData', '/Volumes/cloud/Videos/Dashcam', {
    platform: 'darwin',
    execute: async () => {
      commands += 1
      return { stdout: 'Device Location: Internal\nEjectable: No\n', stderr: '' }
    }
  })

  assert.equal(result.attempted, false)
  assert.equal(result.ejected, false)
  assert.equal(commands, 1)
})
