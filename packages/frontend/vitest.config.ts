import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * Resolve `@odata-visualizer/shared` to its source rather than `dist`.
 *
 * The package's `exports` map points at `./dist`, a gitignored build artifact
 * that nothing builds before `pnpm test`. Verified by hiding
 * `packages/shared/dist`: 9 of the 11 frontend test files failed to load, and
 * with a stale build present the suite passed while testing the wrong code.
 *
 * This alias is load-bearing. There is no test asserting it, because Vitest's
 * browser runner has no access to `node:fs` and cannot resolve module paths;
 * the equivalent guards live in the `mcp` and `backend` suites, which run in
 * Node. Remove it and the fresh-clone failure comes straight back.
 */
const sharedSrc = fileURLToPath(new URL('../shared/src/index.ts', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [{ find: '@odata-visualizer/shared', replacement: sharedSrc }],
  },
  optimizeDeps: {
    // The alias points outside this package, so the dependency optimizer walks
    // the workspace root and pulls in Vite's own watcher chain
    // (vite -> chokidar -> fsevents), whose native `.node` binary has no
    // browser loader. It can never work in a browser bundle, so keep it out.
    exclude: ['fsevents'],
  },
  test: {
    globals: true,
    browser: {
      enabled: true,
      name: 'chromium',
      provider: 'playwright',
      headless: true,
    },
    include: ['__tests__/**/*.test.{ts,tsx}'],
    setupFiles: ['__tests__/setup.ts'],
  },
});
