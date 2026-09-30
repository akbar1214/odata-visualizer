import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Resolve `@odata-visualizer/shared` to its source rather than `dist`.
 *
 * The package's `exports` map points at `./dist`, which is a gitignored build
 * artifact. Nothing built it before `pnpm test`, so on a fresh clone the entry
 * could not be resolved and 9 of 11 backend test files failed to load
 * (`Failed to resolve entry for package "@odata-visualizer/shared"`), while an
 * existing clone silently ran against whatever stale build happened to be on
 * disk.
 */
const sharedSrc = fileURLToPath(new URL('../shared/src/index.ts', import.meta.url));
const sharedLoadSrc = fileURLToPath(new URL('../shared/src/load.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // Longest specifier first: `shared/load` must win over `shared`.
      { find: '@odata-visualizer/shared/load', replacement: sharedLoadSrc },
      { find: '@odata-visualizer/shared', replacement: sharedSrc },
    ],
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
  },
});
