import { PROJECT_IDENTIFIER_PATTERN, type ProjectView } from '@raidiant/notifai-protocol'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { ApiCallError } from './client.js'
import { authedClient, loadLoggedConfig, reportError, EXIT, type CommandDeps } from './commands-core.js'
import { listProjectFolders, updateProjectFolder } from './config.js'
import {
  disableProject,
  enableProject,
  inferredProjectName,
  projectBinding,
  projectEnablementState,
  projectNameNudge,
} from './project-enablement.js'
import { PROJECT_ICON_GROUPS, isProjectIconId } from './project-icons.js'
import { normalizeProjectAvatar, ProjectAvatarError, type ProjectAvatarArtifact } from './project-avatar.js'

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
  const firstEnable = projectEnablementState(binding) === 'unset'
  enableProject(binding)
  deps.io.out(
    `Notifai is enabled for Project "${binding.project}": its notifications and questions reach the User's devices, ` +
      'and agents here get Notifai\'s guidance.' + (firstEnable ? `\n${projectNameNudge(binding.project)}` : ''),
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

const PROJECT_NAME_MAX_LENGTH = 128

export interface ProjectSetFlags {
  project?: string
  name?: string
  avatar?: string
  icon?: string
  removeAvatar?: boolean
  replace?: boolean
  json?: boolean
}

/** A picked icon is also the User's avatar choice; the public view omits settings, the service sends them. */
function hasPickedIcon(view: ProjectView): boolean {
  const settings = (view as { settings?: { icon?: unknown } }).settings
  return typeof settings?.icon === 'string'
}

function projectSetSummary(view: ProjectView): Record<string, unknown> {
  return {
    project: view.identifier,
    project_id: view.project_id,
    display_name: view.display_name,
    custom_avatar: view.image_media_id !== null,
    avatar_revision: view.avatar_revision,
  }
}

/**
 * Set a Project's display name and custom avatar, or remove the avatar,
 * through the routes the dashboard and phone apps use. The Project id stays
 * the lowercase identifier; the name is only what the User reads.
 */
export async function projectSetCommand(deps: CommandDeps, flags: ProjectSetFlags): Promise<number> {
  const fail = (code: string, message: string, exit: number = EXIT.usage): number => {
    if (flags.json) deps.io.out(JSON.stringify({ ok: false, error: { code, message } }))
    else deps.io.err(message)
    return exit
  }
  const name = flags.name?.trim()
  if (name === undefined && flags.avatar === undefined && flags.icon === undefined && flags.removeAvatar !== true) {
    return fail('nothing_to_do', 'Nothing to set. Pass --name "<display name>", --avatar <image file>, --icon <id>, or --remove-avatar.')
  }
  if ([flags.avatar !== undefined, flags.icon !== undefined, flags.removeAvatar === true].filter(Boolean).length > 1) {
    return fail('conflicting_options', '--avatar, --icon and --remove-avatar cannot be used together.')
  }
  if (flags.icon !== undefined && !isProjectIconId(flags.icon)) {
    return fail('invalid_icon', `"${flags.icon}" is not a Project icon. Run \`notifai project icons\` to list them.`)
  }
  if (name !== undefined && (name.length === 0 || name.length > PROJECT_NAME_MAX_LENGTH)) {
    return fail('invalid_name', `The display name must be 1 to ${PROJECT_NAME_MAX_LENGTH} characters.`)
  }

  const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env })
  const identifier = flags.project ?? config.project.value ?? inferredProjectName(deps.cwd, deps.env)
  if (identifier === null || identifier === undefined) {
    return fail('no_project', 'No Project can be inferred here. Run inside a Project or pass --project <id>.')
  }
  if (!new RegExp(PROJECT_IDENTIFIER_PATTERN).test(identifier)) {
    return fail('invalid_project', `"${identifier}" is not a Project id. A Project id is lowercase letters, digits, ".", "_" or "-"; the display name is set with --name.`)
  }

  // Everything local is checked before the first request, so a bad image never leaves a half-applied change.
  let artifact: ProjectAvatarArtifact | null = null
  if (flags.avatar !== undefined) {
    const file = path.resolve(deps.cwd, flags.avatar.replace(/^~(?=$|[\\/])/, deps.env.HOME ?? deps.env.USERPROFILE ?? '~'))
    let source: Buffer
    try {
      source = readFileSync(file)
    } catch {
      return fail('avatar_unreadable', `Cannot read the avatar file ${file}.`)
    }
    try {
      artifact = normalizeProjectAvatar(source)
    } catch (error) {
      if (error instanceof ProjectAvatarError) return fail(error.code, error.message)
      throw error
    }
  }

  const authed = authedClient(deps, config)
  if (!authed) {
    if (flags.json) deps.io.out(JSON.stringify({ ok: false, error: { code: 'auth_required', message: 'Not signed in. Run `notifai init`.' } }))
    return EXIT.auth
  }
  try {
    const before = await authed.client.registerProject(identifier)
    const avatarSet = before.image_media_id !== null || hasPickedIcon(before)
    const conflicts: string[] = []
    if (name !== undefined && before.display_name !== null && before.display_name !== name && flags.replace !== true) {
      conflicts.push(`Project "${identifier}" already has the display name "${before.display_name}".`)
    }
    if ((artifact !== null || flags.icon !== undefined || flags.removeAvatar === true) && avatarSet && flags.replace !== true) {
      conflicts.push(`Project "${identifier}" already has an avatar the User chose.`)
    }
    if (conflicts.length > 0) {
      return fail(
        'already_set',
        `${conflicts.join(' ')} Nothing was changed. Use --replace only when the User asked in this conversation to change it.`,
      )
    }

    let view = before
    const changed = { name: false, avatar: false as false | 'set' | 'icon' | 'removed' }
    if (name !== undefined && before.display_name !== name) {
      view = await authed.client.updateProject(before.project_id, { display_name: name })
      changed.name = true
    }
    if (artifact !== null) {
      view = await authed.client.setProjectAvatar(before.project_id, artifact)
      changed.avatar = 'set'
    } else if (flags.icon !== undefined) {
      view = await authed.client.setProjectIcon(before.project_id, flags.icon)
      changed.avatar = 'icon'
    } else if (flags.removeAvatar === true && avatarSet) {
      view = await authed.client.clearProjectAvatar(before.project_id)
      changed.avatar = 'removed'
    }

    if (flags.json) {
      deps.io.out(JSON.stringify({ ok: true, ...projectSetSummary(view), changed }))
      return EXIT.ok
    }
    const done: string[] = []
    if (changed.name) done.push(`display name "${view.display_name}"`)
    if (changed.avatar === 'set') done.push('custom avatar set')
    if (changed.avatar === 'icon') done.push(`icon "${flags.icon}"`)
    if (changed.avatar === 'removed') done.push('custom avatar removed')
    deps.io.out(
      done.length === 0
        ? `Project "${identifier}" already matches; nothing changed.`
        : `Project "${identifier}": ${done.join(', ')}. The dashboard and the phone apps show it without signing in again.`,
    )
    return EXIT.ok
  } catch (error) {
    if (flags.json) {
      const code = error instanceof ApiCallError ? error.code : 'request_failed'
      deps.io.out(JSON.stringify({ ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } }))
      return error instanceof ApiCallError ? EXIT.failed : EXIT.network
    }
    return reportError(deps, error)
  }
}

/** Every icon an agent can pick with `notifai project set --icon`, by group. */
export function projectIconsCommand(deps: CommandDeps, json = false): number {
  if (json) {
    deps.io.out(JSON.stringify({ groups: PROJECT_ICON_GROUPS.map((group) => ({ name: group.name, icons: group.ids })) }))
    return EXIT.ok
  }
  for (const group of PROJECT_ICON_GROUPS) deps.io.out(`${group.name}: ${group.ids.join(' ')}`)
  return EXIT.ok
}
