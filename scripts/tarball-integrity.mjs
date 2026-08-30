export function expectedTarballFailure(expected, published) {
  return Buffer.compare(expected, published) === 0
    ? null
    : 'the registry tarball bytes differ from the exact scanned tarball passed to npm publish'
}
