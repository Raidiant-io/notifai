import { loadLoggedConfig, EXIT, type CommandDeps } from './commands-core.js'
import {
  disableProject,
  enableProject,
  projectBinding,
  projectEnabled,
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
  deps.io.out(`Notifai lifecycle behavior is enabled for Project "${binding.project}".`)
  return EXIT.ok
}

export function projectDisableCommand(deps: CommandDeps): number {
  const binding = bindingFor(deps)
  if (binding === null) {
    deps.io.err('No Project can be inferred here. Run inside a Project or configure an explicit Project id.')
    return EXIT.usage
  }
  disableProject(binding)
  deps.io.out(`Notifai lifecycle behavior is disabled for Project "${binding.project}".`)
  return EXIT.ok
}

export function projectStatusCommand(deps: CommandDeps, json = false): number {
  const binding = bindingFor(deps)
  const enabled = projectEnabled(binding)
  if (json) {
    deps.io.out(JSON.stringify({ project: binding?.project ?? null, enabled }))
  } else if (binding === null) {
    deps.io.out('No Project can be inferred here; lifecycle behavior is disabled.')
  } else {
    deps.io.out(`Project "${binding.project}": lifecycle behavior ${enabled ? 'enabled' : 'disabled'}.`)
  }
  return EXIT.ok
}
