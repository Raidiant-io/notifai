import { defineConfig } from 'vitest/config'

// Cap the fixtures that exercise process lifetimes, contended installers, or
// real shells. Ordinary unit/policy tests retain Vitest's default parallelism.
const processTests = [
  'session-child', 'hub', 'hook-adapter', 'hook-ingress', 'file-lock',
  'concurrent-send', 'interactive-pty', 'native-launch-retry', 'shell-quoting',
].map(name => `src/${name}.test.ts`)
const shared = { setupFiles: ['./vitest.setup.ts'], testTimeout: 30_000, pool: 'forks' as const }

export default defineConfig({
  test: {
    projects: [
      { test: { ...shared, name: 'unit', include: ['src/**/*.test.ts'], exclude: processTests, sequence: { groupOrder: 0 } } },
      { test: { ...shared, name: 'process', include: processTests, maxWorkers: 2, sequence: { groupOrder: 1 } } },
    ],
  },
})
