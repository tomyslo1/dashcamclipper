const { execFile } = require('node:child_process')
const path = require('node:path')

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true
    }, (error, stdout = '', stderr = '') => {
      if (error) {
        error.stdout = stdout
        error.stderr = stderr
        reject(error)
        return
      }

      resolve({ stdout, stderr })
    })
  })
}

function pathsMatch(left, right, platform = process.platform) {
  if (!left || !right) {
    return false
  }

  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const normalizedLeft = pathApi.resolve(left).replace(/[\\/]+$/, '')
  const normalizedRight = pathApi.resolve(right).replace(/[\\/]+$/, '')

  return platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

function windowsDriveRoot(sourcePath) {
  const root = path.win32.parse(path.win32.resolve(sourcePath)).root
  return /^[a-z]:\\$/i.test(root) ? root : null
}

function macVolumeRoot(sourcePath) {
  const normalized = path.posix.resolve(sourcePath)
  const match = normalized.match(/^\/Volumes\/[^/]+/)
  return match ? match[0] : null
}

function commandOutput(error) {
  return `${error?.stdout || ''}\n${error?.stderr || ''}`.trim()
}

async function ejectWindowsSource(sourcePath, execute = runCommand) {
  const driveRoot = windowsDriveRoot(sourcePath)

  if (!driveRoot) {
    return { requested: true, attempted: false, ejected: false, message: 'The source is not a removable Windows drive.' }
  }

  const driveLetter = driveRoot[0].toUpperCase()
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$letter = '${driveLetter}'`,
    'try { $disk = Get-Partition -DriveLetter $letter | Get-Disk } catch { Write-Output "not-external"; exit 5 }',
    "$bus = [string]$disk.BusType",
    "if ($disk.IsBoot -or $disk.IsSystem -or $bus -notin @('USB', 'SD', 'MMC')) { Write-Output 'not-external'; exit 5 }",
    "$item = (New-Object -ComObject Shell.Application).Namespace(17).ParseName($letter + ':')",
    "if ($null -eq $item) { Write-Output 'eject-failed'; exit 6 }",
    "$item.InvokeVerb('Eject')",
    "for ($index = 0; $index -lt 16; $index++) { Start-Sleep -Milliseconds 250; if (-not (Test-Path ($letter + ':\\'))) { Write-Output 'ejected'; exit 0 } }",
    "Write-Output 'eject-failed'",
    'exit 6'
  ].join('; ')

  try {
    await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
    return { requested: true, attempted: true, ejected: true, message: 'The microSD card was ejected safely.' }
  } catch (error) {
    const output = commandOutput(error)

    if (output.includes('not-external')) {
      return { requested: true, attempted: false, ejected: false, message: 'The source did not appear to be an external microSD drive.' }
    }

    return { requested: true, attempted: true, ejected: false, message: 'Windows could not eject the source. Close programs using it and eject it manually.' }
  }
}

async function ejectMacSource(sourcePath, execute = runCommand) {
  const volumeRoot = macVolumeRoot(sourcePath)

  if (!volumeRoot) {
    return { requested: true, attempted: false, ejected: false, message: 'The source is not mounted as an external macOS volume.' }
  }

  let information

  try {
    information = await execute('/usr/sbin/diskutil', ['info', volumeRoot])
  } catch {
    return { requested: true, attempted: false, ejected: false, message: 'macOS could not identify the source volume.' }
  }

  const details = information.stdout || ''
  const isExternal = /Device Location:\s+External/i.test(details)
  const isEjectable = /Ejectable:\s+Yes/i.test(details) || /Removable Media:\s+(?:Removable|Yes)/i.test(details)

  if (!isExternal || !isEjectable) {
    return { requested: true, attempted: false, ejected: false, message: 'The source did not appear to be an external microSD volume.' }
  }

  try {
    await execute('/usr/sbin/diskutil', ['eject', volumeRoot])
    return { requested: true, attempted: true, ejected: true, message: 'The microSD card was ejected safely.' }
  } catch {
    return { requested: true, attempted: true, ejected: false, message: 'macOS could not eject the source. Close programs using it and eject it manually.' }
  }
}

async function ejectSource(sourcePath, libraryPath, options = {}) {
  const platform = options.platform || process.platform
  const execute = options.execute || runCommand

  if (pathsMatch(sourcePath, libraryPath, platform)) {
    return { requested: false, attempted: false, ejected: false, message: '' }
  }

  if (platform === 'win32') {
    return ejectWindowsSource(sourcePath, execute)
  }

  if (platform === 'darwin') {
    return ejectMacSource(sourcePath, execute)
  }

  return { requested: true, attempted: false, ejected: false, message: 'Automatic eject is not supported on this operating system.' }
}

module.exports = {
  ejectMacSource,
  ejectSource,
  ejectWindowsSource,
  macVolumeRoot,
  pathsMatch,
  windowsDriveRoot
}
