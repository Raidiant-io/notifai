import { loadLoggedConfig, EXIT, type CommandDeps } from './commands-core.js'
import {
  disableProject,
  enableProject,
  projectBinding,
  projectEnablementState,
} from './project-enablement.js'

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
    deps.io.out('No Project can be inferred here; lifecycle behavior is disabled.')
  } else if (decision === 'disabled') {
    deps.io.out(
      `Project "${binding.project}": lifecycle behavior disabled. The User disabled Notifai here: nothing from it reaches the User's devices.`,
    )
  } else {
    deps.io.out(`Project "${binding.project}": lifecycle behavior ${decision === 'enabled' ? 'enabled' : 'disabled'}.`)
  }
  return EXIT.ok
}
