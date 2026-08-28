import assert from 'node:assert/strict'
import test from 'node:test'
import { publishedVersionArgument } from './verify-published-windows.mjs'

test('published Windows verification requires one exact package version', () => {
  assert.equal(publishedVersionArgument(['node', 'script', '9.4.0']), '9.4.0')
  assert.equal(publishedVersionArgument(['node', 'script', '10.0.0-beta.1']), '10.0.0-beta.1')
  assert.throws(() => publishedVersionArgument(['node', 'script', 'latest']), /exact-version/)
  assert.throws(() => publishedVersionArgument(['node', 'script']), /exact-version/)
})
