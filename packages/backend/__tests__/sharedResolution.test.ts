import { describe, it, expect } from 'vitest';
// @ts-expect-error -- the real config module, resolved relative to this file.
import config from '../vitest.config';

/**
 * `@odata-visualizer/shared` and `@odata-visualizer/mcp` both declare `exports`
 * pointing at `./dist`, which is gitignored and never built by `pnpm test`.
 *
 * Verified by hiding both directories (a true fresh clone):
 *   - `shared` hidden only: 9 of 11 backend test files failed to load, 28 ran
 *   - `mcp` hidden only:    8 of 11 backend test files failed to load, 39 ran
 *   - both hidden:          back to 28 of 113
 *
 * The aliases in `vitest.config.ts` are what prevent this, so assert they exist.
 * This checks the configuration rather than the running module graph because
 * Vitest's SSR transform does not provide `import.meta.resolve`. It is a shape
 * assertion: it would not notice a refactor that kept the behaviour but changed
 * the form, and it can only fail for the reason it describes.
 */
describe('workspace package resolution', () => {
  const aliases = (config.resolve?.alias ?? []) as Array<{ find: string; replacement: string }>;

  const expected: Array<[specifier: string, packageDir: string, sourceFile: string]> = [
    ['@odata-visualizer/shared', 'shared', 'index.ts'],
    ['@odata-visualizer/shared/load', 'shared', 'load.ts'],
    ['@odata-visualizer/mcp', 'mcp', 'index.ts'],
    ['@odata-visualizer/mcp/server', 'mcp', 'server.ts'],
  ];

  it.each(expected)(
    'aliases %s to source, not to a build artifact',
    (specifier, packageDir, sourceFile) => {
      const match = aliases.find((alias) => alias.find === specifier);

      expect(match, `no alias configured for ${specifier}`).toBeDefined();
      expect(match!.replacement).toContain(`/${packageDir}/src/`);
      expect(match!.replacement).toContain(sourceFile);
      expect(match!.replacement).not.toContain(`/${packageDir}/dist/`);
    },
  );

  it.each([
    ['@odata-visualizer/shared/load', '@odata-visualizer/shared'],
    ['@odata-visualizer/mcp/server', '@odata-visualizer/mcp'],
  ])('lists the %s subpath alias before its bare package', (subpath, bare) => {
    // Vite picks the first matching alias, so a subpath has to come first or it
    // would be swallowed by the bare package entry.
    const index = (specifier: string) => aliases.findIndex((a) => a.find === specifier);

    expect(index(subpath)).toBeLessThan(index(bare));
  });
});
