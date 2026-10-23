import { defineConfig } from 'vitest/config'

const pure = ['local-continuity', 'config-schema', 'bounded-json-record', 'sound-ref',
  'node-floor', 'version', 'cli-release', 'installation-windows-path'].map(name => `src/${name}.test.ts`)
const shared = { setupFiles: ['./vitest.setup.ts'], testTimeout: 30_000, pool: 'forks' as const }

export default defineConfig({
  test: {
    projects: [
      { test: { ...shared, name: 'policy', include: pure, maxWorkers: 4, sequence: { groupOrder: 0 } } },
      { test: { ...shared, name: 'process', include: ['src/**/*.test.ts'], exclude: pure, maxWorkers: 2, sequence: { groupOrder: 1 } } },
    ],
  },
})
