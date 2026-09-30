import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Resolve `@odata-visualizer/shared` to its source rather than `dist`.
 *
 * The package's `exports` map points at `./dist`, a gitignored build artifact
 * that nothing builds before `pnpm test`. On a fresh clone the entry does not
 * resolve and the suite fails loudly — 2 of 3 test files, 65 of 70 tests. With a
 * stale build present the suite instead passes while exercising old code, which
 * is the more dangerous of the two failure modes.
 *
 * Tests should exercise the source they sit next to; `dist` remains the entry
 * point for the compiled consumers.
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
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
