function parseVersion(value) {
  const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/)

  if (!match) {
    return null
  }

  return match.slice(1).map(Number)
}

function isNewerVersion(candidate, current) {
  const candidateParts = parseVersion(candidate)
  const currentParts = parseVersion(current)

  if (!candidateParts || !currentParts) {
    return false
  }

  for (let index = 0; index < candidateParts.length; index += 1) {
    if (candidateParts[index] !== currentParts[index]) {
      return candidateParts[index] > currentParts[index]
    }
  }

  return false
}

function isReleaseUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      url.pathname.startsWith('/tomyslo1/dashcamclipper/releases/')
  } catch {
    return false
  }
}

function buildUpdateStatus(currentVersion, release) {
  const latestVersion = String(release?.tag_name || '').replace(/^v/i, '')
  const releaseUrl = isReleaseUrl(release?.html_url) ? release.html_url : ''
  const available = Boolean(releaseUrl) && isNewerVersion(latestVersion, currentVersion)

  return {
    available,
    currentVersion,
    latestVersion: parseVersion(latestVersion) ? latestVersion : '',
    releaseUrl: available ? releaseUrl : ''
  }
}

module.exports = {
  buildUpdateStatus,
  isNewerVersion,
  isReleaseUrl,
  parseVersion
}
