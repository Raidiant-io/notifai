import { loadLoggedConfig, EXIT, type CommandDeps } from './commands-core.js'
import { listProjectFolders, updateProjectFolder } from './config.js'
import path from 'node:path'
import {
  disableProject,
  enableProject,
  projectBinding,
  projectEnablementState,
} from './project-enablement.js'

export function projectFolderCommand(
  deps: CommandDeps,
  action: 'add' | 'list' | 'remove' | 'rename',
  directory: string | undefined,
  flags: { name?: string; json?: boolean },
): number {
  try {
    if (action === 'list') {
      const folders = listProjectFolders(deps.env)
      if (flags.json) deps.io.out(JSON.stringify({ folders }))
      else if (folders.length === 0) deps.io.out('No folder Projects are registered on this computer.')
      else for (const folder of folders) deps.io.out(`${folder.name}\t${folder.path}`)
    } else {
      const folder = updateProjectFolder(action, path.resolve(deps.cwd, directory ?? '.'), flags.name, deps.env)
      if (flags.json) deps.io.out(JSON.stringify({ folder: action === 'remove' ? null : folder }))
      else deps.io.out(`${action === 'remove' ? 'Removed' : action === 'rename' ? 'Renamed' : 'Added'} folder Project "${folder.name}" (${folder.path}).`)
    }
    return EXIT.ok
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (flags.json) deps.io.out(JSON.stringify({ ok: false, error: message }))
    else deps.io.err(message)
    return EXIT.usage
  }
}

function bindingFor(deps: CommandDeps) {
  const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env })
  return projectBinding(deps.cwd, deps.env, config.project.value)
}

export function projectEnableCommand(deps: CommandDeps): number {
  const binding = bindingFor(deps)
  if (binding === null) {
    deps.io.err('No Project can be inferred here. Run inside a Project or configure an explicit Project id.')
    return EXIT.usage
  }
  enableProject(binding)
  deps.io.out(
    `Notifai is enabled for Project "${binding.project}": its notifications and questions reach the User's devices, ` +
      'and agents here get Notifai\'s guidance.',
  )
  return EXIT.ok
}

export function projectDisableCommand(deps: CommandDeps): number {
  const binding = bindingFor(deps)
  if (binding === null) {
    deps.io.err('No Project can be inferred here. Run inside a Project or configure an explicit Project id.')
    return EXIT.usage
  }
  disableProject(binding)
  deps.io.out(
    `Notifai is disabled for Project "${binding.project}": nothing from it reaches the User's devices until ` +
      '`notifai project enable`.',
  )
  return EXIT.ok
}

export function projectStatusCommand(deps: CommandDeps, json = false): number {
  const binding = bindingFor(deps)
  const decision = projectEnablementState(binding)
  if (json) {
    deps.io.out(JSON.stringify({ project: binding?.project ?? null, enabled: decision === 'enabled', disabled: decision === 'disabled' }))
  } else if (binding === null) {
    deps.io.out('No Project can be inferred here; lifecycle behavior is off.')
  } else if (decision === 'disabled') {
    deps.io.out(
      `Project "${binding.project}": lifecycle behavior disabled. The User disabled Notifai here: nothing from it reaches the User's devices.`,
    )
  } else if (decision === 'enabled') {
    deps.io.out(`Project "${binding.project}": lifecycle behavior enabled.`)
  } else {
    deps.io.out(
      `Project "${binding.project}": lifecycle behavior off; the User has neither enabled nor disabled Notifai here. When they ask for Notifai here, run \`notifai project enable\`.`,
    )
  }
  return EXIT.ok
}
