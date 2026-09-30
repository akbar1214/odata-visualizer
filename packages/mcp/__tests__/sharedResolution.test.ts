import { describe, it, expect } from 'vitest';
// @ts-expect-error -- the real config module, resolved relative to this file.
import config from '../vitest.config';

/**
 * `@odata-visualizer/shared` declares `exports` pointing at `./dist`, a
 * gitignored build artifact that nothing built before `pnpm test`.
 *
 * Consequences, both verified by hiding/replacing `packages/shared/dist`:
 *   - fresh clone: `Failed to resolve entry for package "@odata-visualizer/shared"`,
 *     and 183 of 368 tests silently failed to load;
 *   - existing clone: the suites passed while exercising a stale build.
 *
 * The alias in `vitest.config.ts` is what prevents this, so assert it exists.
 * This checks the configuration rather than the running module graph because
 * Vitest's SSR transform does not provide `import.meta.resolve`.
 */
describe('shared package resolution', () => {
  const aliases = (config.resolve?.alias ?? []) as Array<{ find: string; replacement: string }>;

  it.each([
    ['@odata-visualizer/shared', 'index.ts'],
    ['@odata-visualizer/shared/load', 'load.ts'],
  ])('aliases %s to source, not to a build artifact', (specifier, sourceFile) => {
    const match = aliases.find((alias) => alias.find === specifier);

    expect(match, `no alias configured for ${specifier}`).toBeDefined();
    expect(match!.replacement).toContain('/shared/src/');
    expect(match!.replacement).toContain(sourceFile);
    expect(match!.replacement).not.toContain('/shared/dist/');
  });

  it('lists the subpath alias before the bare specifier', () => {
    // Vite picks the first matching alias, so `shared/load` has to come first
    // or it would be swallowed by the `shared` entry.
    const index = (specifier: string) => aliases.findIndex((a) => a.find === specifier);

    expect(index('@odata-visualizer/shared/load')).toBeLessThan(
      index('@odata-visualizer/shared'),
    );
  });
});
