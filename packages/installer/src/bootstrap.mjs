import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { extractReleaseArchive } from './shared/release-archive.js'

/** The bootstrap authenticates before first execution. The compiled CLI alone
 * owns installation, setup, PATH, channel state and later runtime updates. */
export async function installStandalone(options, { distribution: createDistribution, platform }) {
  const args = ['install', '--source', 'npm']
  if (options.json) args.push('--json')
  if (options.version) args.push('--version', options.version)
  if (options.channel) args.push('--channel', options.channel)
  if (options['no-init']) args.push('--no-init')
  if (options['no-path']) args.push('--no-path')
  const existing = platform.existingCommand()
  if (existing !== null) return platform.execute(existing, args)
  const distribution = createDistribution()
  const target = platform.target()
  const release = await distribution.resolveRelease({ channel: options.channel ?? 'stable', target,
    ...(options.version ? { version: options.version } : {}) })
  const bytes = await distribution.downloadArtifact(release)
  const temporary = platform.temporaryDirectory()
  try {
    const directory = await extractReleaseArchive({ distribution, signedInventory: release.signedInventory, target, bytes, parent: temporary })
    // A portable archive carries the native executables and notices. Its signed
    // release inventory is an independent asset admitted by the bootstrap.
    writeFileSync(path.join(directory, 'inventory.json'), release.signedInventory, { flag: 'wx', mode: 0o600 })
    platform.checkPublisher(directory)
    return platform.execute(path.join(directory, target.startsWith('bun-windows-') ? 'notifai.exe' : 'notifai'), args)
  } finally { rmSync(temporary, { recursive: true, force: true }) }
}
