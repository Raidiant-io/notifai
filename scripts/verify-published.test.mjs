import assert from 'node:assert/strict'
import test from 'node:test'
import { expectedTarballFailure } from './tarball-integrity.mjs'

test('accepts registry bytes only when they equal the staged tarball exactly', () => {
  const artifact = Buffer.from('exact packed bytes')
  assert.equal(expectedTarballFailure(artifact, Buffer.from(artifact)), null)
  assert.match(expectedTarballFailure(artifact, Buffer.from('repacked bytes')), /differ/)
})
