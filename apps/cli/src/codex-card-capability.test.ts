import { expect, it } from 'vitest'
import { CODEX_CARD_VERSION_FLOOR, codexCardVersionVerdict } from './codex-card-capability.js'

it('pins the card floor to the Codex release the card round trip was reproduced on', () => {
  expect(CODEX_CARD_VERSION_FLOOR).toBe('0.163.0')
})

it.each([
  ['0.163.0', true],
  ['v0.163.0', true],
  ['0.163.1', true],
  ['0.164.0', true],
  ['0.164.0-alpha.1', true],
  ['1.0.0', true],
  ['0.163.0+build.7', true],
  ['0.162.0', false],
  ['0.162.99', false],
  ['0.9.9', false],
  ['0.163.0-alpha.3', false],
])('compares %s against the floor by SemVer precedence: supported %s', (version, supported) => {
  const verdict = codexCardVersionVerdict(version)
  expect(verdict.supported).toBe(supported)
  expect(verdict.version).toBe(version)
  if (!verdict.supported) expect(verdict.reason).toBe('below_floor')
})

it.each([undefined, null, '', '   ', 42, 'latest', '0.163', 'codex-cli 0.163.0'])('fails closed on a missing or unparseable version: %j', version => {
  const verdict = codexCardVersionVerdict(version)
  expect(verdict.supported).toBe(false)
  if (!verdict.supported) expect(verdict.reason).toBe('unknown_version')
})
