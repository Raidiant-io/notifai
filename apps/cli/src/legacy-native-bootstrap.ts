/** Exact signed releases whose ordinary/retained-owner admission and core
 * installation writes reject the missing top-level install.json target. These are rejection proofs,
 * not permission for concurrent state writers. Bootstrap still needs quiescence.
 * Source groups: native identity/admission and Installation's locked core writes.
 * Actual historical artifact acceptance is a release gate. */
export const LEGACY_BOOTSTRAP_INVENTORIES: readonly string[] = [
  '9ac658e1ae8f23086ef1955ae7294895ec961c33ef9398aa78e5c701fe5590ee', // 11.8.0-beta.2
  '9292a6b7f848c159b6cefdb07cdc105244a273fb9fa078b041332d6902321c1d', // 11.8.0-beta.3
  '0608faebf32c9cc6916458658c75f68a91c9f7c1ab670828f977f7ab5f8c9a1b', // 11.8.0-beta.4
  '4a2695acb69714afd5a9dd5493e75bb0f1b72896df4bd4ef1eff133e98aae41f', // 11.8.0-beta.5
  '5df2f35b3e8fe50a14a8ac8ecdd0afcd03d33414d1799c607d9c04d069bdbbe6', // 11.8.0-beta.7
  'ce90684e49b3001dee8707f09699f0da8d14164e53d8894d5067a6eefff981a9', // 11.8.0
  '8f29fefb193e9002e729f495853256dfc45ffba0a965fc0235ee0f178d862df2', // 11.8.1-beta.1
  '40aa8de47678a58829f69277f262517c982837b724e3f99d28b702e57b9d760c', // 12.0.0-beta.8
  '0b0033c19be1c0c286b2a1e39ed3aeec2ceb5fe2384f67b4949a3e28a58ddc6f', // 12.0.0-beta.11
  '714ae06bfd61db669931a0cbb06d65a07f5adb2dcdc28647c1b7b33b62f13dfb', // 12.0.0-beta.13
  '88ce51863ade168d0356e9d7dde60890f54e28c360421c5ec158f0520354e9fc', // 12.0.0-beta.15
]
