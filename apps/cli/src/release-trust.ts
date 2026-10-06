/** Release public keys are reviewed source inputs. Never discover trust roots
 * from environment, project files or the release being verified. Publication
 * must provision a protected signing key and commit its public half here first. */
export const RELEASE_PUBLIC_KEYS: Readonly<Record<string, string>> = Object.freeze({
  'notifai-release-2026-10': "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA62imKxrs7TtFZ7qNfogy/Q4HUno4EE6kIwb5g43Phw4=\n-----END PUBLIC KEY-----\n",
})
