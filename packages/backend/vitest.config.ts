import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Resolve workspace packages to their source rather than their `dist` output.
 *
 * Both `@odata-visualizer/shared` and `@odata-visualizer/mcp` declare `exports`
 * pointing at `./dist`, which is gitignored and not built by `pnpm test`. On a
 * fresh clone neither entry resolves at all — 9 of 11 backend test files failed
 * to load and only 28 of 113 tests ran — and with a stale build on disk the
 * suite passes while exercising old code.
 *
 * `@odata-visualizer/mcp` matters as much as `shared`: the backend mounts the
 * MCP server, so `mcp.ts` and `metadataStore.ts` import
 * `@odata-visualizer/mcp/server`. Aliasing only `shared` left 8 of 11 files
 * failing to load.
 */
function src(relative: string): string {
  return fileURLToPath(new URL(relative, import.meta.url));
}

export default defineConfig({
  resolve: {
    alias: [
      // Longest specifier first: a subpath alias must win over its bare package.
      { find: '@odata-visualizer/shared/load', replacement: src('../shared/src/load.ts') },
      { find: '@odata-visualizer/shared', replacement: src('../shared/src/index.ts') },
      { find: '@odata-visualizer/mcp/server', replacement: src('../mcp/src/server.ts') },
      { find: '@odata-visualizer/mcp', replacement: src('../mcp/src/index.ts') },
    ],
  },
});
