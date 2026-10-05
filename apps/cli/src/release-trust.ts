/** Release public keys are reviewed source inputs. Never discover trust roots
 * from environment, project files or the release being verified. Publication
 * must provision a protected signing key and commit its public half here first. */
export const RELEASE_PUBLIC_KEYS: Readonly<Record<string, string>> = Object.freeze({})
