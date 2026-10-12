/** Published package-file inventory: sorted [path, bytes, sha256] tuples,
 * excluding npm-installed node_modules. Dependency bytes are not release proof.
 * 11.7.1 is the last observed Node CLI; unknown releases remain untouched. */
export const LEGACY_NPM_RELEASES: Readonly<Record<string, { files: number; sha256: string }>> = {
  '11.7.1': { files: 403, sha256: '8de6b70619e7e406d9e1338a25b54d3a04f6fadfb5a44437d04ad8c550dd5bf9' },
}
