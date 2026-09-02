export {
  EXIT,
  updateCliCommand,
  type CommandDeps,
  type CommandIo,
  type CommandSpinner,
} from './commands-core.js'
export {
  accessStatusCommand,
  authStatusCommand,
  loginCommand,
  logoutCommand,
} from './commands-auth.js'
export {
  canDeviceReceive,
  capabilitiesCommand,
  deviceInventory,
  devicesCommand,
} from './commands-devices.js'
export { soundsCommand } from './commands-sounds.js'
export {
  contradictingAnswer,
  repliesCommand,
  sendCommand,
  statusCommand,
} from './commands-send.js'
/** @public The private service's CLI contract test drives replies through this. */
export { waitForReply } from './commands-send-support.js'
export {
  acknowledgeCommand,
  askCommand,
  buildQuestions,
  closeCommand,
  describeHookFailure,
  hookDefersDiagnosticsUntilAfterCleanup,
  hookRunCommand,
  hooksInstallCommand,
  hooksUninstallCommand,
  reportAskFailure,
} from './commands-hooks.js'
export {
  configExplainCommand,
  configSetCommand,
  configShowCommand,
  configUnsetCommand,
} from './commands-config.js'
export {
  guidanceSetCommand,
  guidanceShowCommand,
  guidanceUnsetCommand,
} from './commands-guidance.js'
export { logsCommand, parseSince } from './commands-logs.js'
export { SKILLS_SOURCE } from './commands-skill.js'
export { initCommand, projectSlugFrom } from './commands-init.js'
export { assessReadiness, doctorCommand } from './commands-doctor.js'
export { cliUpdateCommand } from './commands-update.js'
export {
  projectDisableCommand,
  projectEnableCommand,
  projectStatusCommand,
} from './commands-project.js'
export { agentSessionRenameCommand } from './commands-agent-sessions.js'
export { realIo } from './commands-io.js'
