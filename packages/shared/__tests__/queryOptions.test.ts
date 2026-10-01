import { describe, it, expect } from 'vitest';
import { buildQueryOptions, buildQueryUrl } from '../src/query.js';

/**
 * `buildQueryOptions` renders the system query options after a resource path.
 * It is shared by `buildQueryUrl` and by bound-function invocation URLs, where
 * the resource path is the function segment (`As('1')/N.B()?$expand=...`).
 */
describe('buildQueryOptions', () => {
  it('returns an empty string when no options are requested', () => {
    expect(buildQueryOptions({})).toBe('');
  });

  it('renders filters, select and paging without a resource path', () => {
    expect(
      buildQueryOptions({
        filters: [{ property: 'Name', operator: 'eq', value: 'x' }],
        select: ['Id'],
        top: 2,
      }),
    ).toBe("?$filter=Name%20eq%20'x'&$select=Id&$top=2");
  });

  it('types filter literals from the model when metadata is supplied', () => {
    const metadata = {
      version: '4.0',
      entities: [
        {
          name: 'Part',
          qualifiedName: 'N.Part',
          namespace: 'N',
          properties: [{ name: 'Count', type: 'Edm.Int32', nullable: false, isKey: false }],
          navigationProperties: [],
          keys: [],
        },
      ],
      relationships: [],
      entityContainers: [],
      functionImports: [],
      actionImports: [],
      actions: [],
      functions: [],
      enumTypes: [],
      typeDefinitions: [],
    };

    expect(
      buildQueryOptions({
        rootEntityName: 'N.Part',
        metadata,
        filters: [{ property: 'Count', operator: 'gt', value: '3' }],
      }),
    ).toBe('?$filter=Count%20gt%203');
  });

  it('produces the same query string buildQueryUrl embeds', () => {
    const query = buildQueryOptions({
      filters: [{ property: 'Name', operator: 'eq', value: "O'Brien" }],
      select: ['Id'],
      orderBy: 'Name desc',
      top: 5,
      skip: 1,
      count: true,
    });

    expect(
      buildQueryUrl({
        entitySet: 'Parts',
        filters: [{ property: 'Name', operator: 'eq', value: "O'Brien" }],
        select: ['Id'],
        orderBy: 'Name desc',
        top: 5,
        skip: 1,
        count: true,
      }),
    ).toBe(`/Parts${query}`);
  });
});
