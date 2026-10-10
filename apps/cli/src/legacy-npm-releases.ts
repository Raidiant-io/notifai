/** Published package-file inventory: sorted [path, bytes, sha256] tuples,
 * excluding npm-installed node_modules. Dependency bytes are not release proof.
 * 11.7.1 is the last observed Node CLI; unknown releases remain untouched. */
export const LEGACY_NPM_RELEASES: Readonly<Record<string, { files: number; sha256: string }>> = {
  '11.7.1': { files: 403, sha256: '8de6b70619e7e406d9e1338a25b54d3a04f6fadfb5a44437d04ad8c550dd5bf9' },
}

/** Authenticate compressed bytes before npm parses them. The signed native
 * inventory independently authenticates the resulting adapter payload. */
export const NPM_MIGRATION_ADAPTER = { version: '12.0.0-beta.15', integrity:
  'PkbNLMqnkDYZ4POlrCzQl+PjHfvj/RLK8XMx73W9O5zJ7qJdViZbwOxBBOHlwYEaZvtzHHTq/C5V0BJhRBgIWg==' }
