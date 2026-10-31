import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

/** An open vocabulary: clients render unfamiliar kinds generically. */
export const SetupIssueKind = Type.String({ pattern: '^[a-z][a-z0-9_]{0,63}$' })
const BoundedName = Type.String({ minLength: 1, maxLength: 128, pattern: '^[^\\u0000-\\u001f\\u007f-\\u009f]+$' })
export const SetupIssueParams = Type.Object({
  codex_home: Type.Optional(Type.String({ minLength: 1, maxLength: 512, pattern: '^[^\\u0000-\\u001f\\u007f-\\u009f]+$' })),
  platform: Type.Optional(Type.Union([Type.Literal('darwin'), Type.Literal('linux'), Type.Literal('win32')])),
})
export type SetupIssueParams = Static<typeof SetupIssueParams>

/** Machine-authenticated snapshot. Unknown parameter keys are discarded by the service. */
export const MachineSetupIssue = Type.Object({
  key: Type.String({ minLength: 1, maxLength: 192, pattern: '^[^\\u0000-\\u001f\\u007f-\\u009f]+$' }),
  kind: SetupIssueKind,
  harness: Type.Optional(BoundedName),
  host: Type.Optional(Type.Union([Type.Literal('t3'), Type.Literal('codex_app')])),
  session_ids: Type.Array(BoundedName, { maxItems: 100, uniqueItems: true }),
  lost: Type.Array(SetupIssueKind, { maxItems: 16, uniqueItems: true }),
  fixer: Type.Union([Type.Literal('user_at_computer'), Type.Literal('agent')]),
  params: SetupIssueParams,
}, { additionalProperties: false })
export type MachineSetupIssue = Static<typeof MachineSetupIssue>

/** `PUT /api/v1/machine/setup-issues`; replaces all machine-reported issues. */
export const PutMachineSetupIssuesRequest = Type.Object({
  issues: Type.Array(MachineSetupIssue, { maxItems: 32 }),
}, { additionalProperties: false })
export type PutMachineSetupIssuesRequest = Static<typeof PutMachineSetupIssuesRequest>
export const PutMachineSetupIssuesResponse = Type.Object({ ok: Type.Literal(true) })
export type PutMachineSetupIssuesResponse = Static<typeof PutMachineSetupIssuesResponse>

/** No executable fix instructions, URLs, or server-authored copy travel in this view. */
export const SetupIssue = Type.Object({
  id: Type.String({ minLength: 1 }),
  kind: SetupIssueKind,
  severity: Type.Union([Type.Literal('notice'), Type.Literal('broken')]),
  machine_id: Type.String({ minLength: 1 }),
  machine_name: Type.String(),
  fixer: MachineSetupIssue.properties.fixer,
  lost: MachineSetupIssue.properties.lost,
  harness: Type.Optional(BoundedName),
  host: MachineSetupIssue.properties.host,
  session_ids: MachineSetupIssue.properties.session_ids,
  params: SetupIssueParams,
  /** Fixed for the episode, including short interruptions in reporting. */
  since: Type.String(),
})
export type SetupIssue = Static<typeof SetupIssue>

/** `GET /api/v1/setup-issues` (User authentication). */
export const SetupIssuesResponse = Type.Object({ issues: Type.Array(SetupIssue) })
export type SetupIssuesResponse = Static<typeof SetupIssuesResponse>
export function isSetupIssuesResponse(value: unknown): value is SetupIssuesResponse {
  return Value.Check(SetupIssuesResponse, value)
}
