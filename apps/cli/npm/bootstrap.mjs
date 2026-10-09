import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { extractReleaseArchive } from '../dist/release-archive.js'

/** Only the authenticated native installer mutates installation records. */
export async function acquireNative(release, { distribution, platform, capture = false, installArgs = [] }) {
  const admitted = distribution.resolveExactRelease({ signedInventory: release.signedInventory,
    version: release.manifest.native.version, sourceRevision: release.manifest.native.source_revision, target: platform.target() })
  const bytes = await distribution.downloadArtifact(admitted)
  const temporary = platform.temporaryDirectory()
  try {
    const directory = await extractReleaseArchive({ distribution, signedInventory: admitted.signedInventory,
      target: admitted.artifact.target, bytes, parent: temporary })
    writeFileSync(path.join(directory, 'inventory.json'), admitted.signedInventory, { flag: 'wx', mode: 0o600 })
    platform.checkPublisher(directory)
    const executable = path.join(directory, admitted.artifact.target.startsWith('bun-windows-') ? 'notifai.exe' : 'notifai')
    const args = ['install', '--source', 'npm', '--version', admitted.inventory.version,
      '--channel', admitted.inventory.version.split('+')[0].includes('-') ? 'beta' : 'stable', ...installArgs]
    if (!capture) return platform.execute(executable, args)
    const result = await platform.capture(executable, [...args, '--no-init', '--json'])
    let report
    try { report = JSON.parse(result.stdout) } catch { throw new Error('Native installer did not return one valid installation report') }
    assert.ok(report && typeof report === 'object' && !Array.isArray(report), 'Invalid native installation report')
    return { status: result.status, report }
  } finally { rmSync(temporary, { recursive: true, force: true }) }
}
