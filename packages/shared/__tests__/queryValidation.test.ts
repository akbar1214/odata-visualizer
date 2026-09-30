import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCSDL } from '../src/parser.js';
import type { ODataMetadata } from '../src/types.js';
import { buildQueryUrl } from '../src/query.js';

const windchillCSDL = readFileSync(
  fileURLToPath(new URL('./fixtures/windchill-prodmgmt.xml', import.meta.url)),
  'utf-8',
);

let metadata: ODataMetadata;

beforeAll(async () => {
  metadata = await parseCSDL(windchillCSDL);
});

/**
 * Regression coverage for query-builder input validation.
 *
 * Every value that ends up in a generated URL is either an OData identifier
 * (property, navigation property, sort field) or a resource path segment. The
 * builder used to splice these in verbatim, so a value such as
 * `Parts?$filter=...` or `x in (1) or true` could inject an extra query
 * parameter or extra filter logic, and nested `$expand` options were never
 * checked at all.
 */
describe('buildQueryUrl input validation', () => {
  describe('resource path', () => {
    it('rejects an entitySet that injects a query string', () => {
      expect(() => buildQueryUrl({ entitySet: 'Parts?$filter=1 eq 1' })).toThrow(/entitySet/);
    });

    it('rejects an entitySet carrying URL structure or whitespace', () => {
      for (const value of [
        'Parts#fragment',
        'Parts&$top=9',
        "Parts'",
        'Parts"',
        ' Parts',
        'Parts ',
        'Parts\tName',
        'Parts\\Name',
        'Parts%20Name',
      ]) {
        expect(() => buildQueryUrl({ entitySet: value }), `expected ${JSON.stringify(value)} to be rejected`)
          .toThrow(/entitySet/);
      }
    });

    it('still accepts qualified type names and container-qualified paths', () => {
      expect(buildQueryUrl({ entitySet: 'SampleService.Models.Part' })).toBe(
        '/SampleService.Models.Part',
      );
      expect(buildQueryUrl({ entitySet: 'Container/Parts' })).toBe('/Container/Parts');
      expect(buildQueryUrl({ entitySet: 'Parts_2' })).toBe('/Parts_2');
    });

    it('rejects empty, trailing, or repeated path separators', () => {
      expect(() => buildQueryUrl({ entitySet: '/Parts' })).toThrow(/entitySet/);
      expect(() => buildQueryUrl({ entitySet: 'Parts/' })).toThrow(/entitySet/);
      expect(() => buildQueryUrl({ entitySet: 'Container//Parts' })).toThrow(/entitySet/);
    });

    it('rejects an empty entitySet', () => {
      expect(() => buildQueryUrl({ entitySet: '   ' })).toThrow(/entitySet/);
    });
  });

  describe('property names', () => {
    it('rejects a filter property that injects filter logic', () => {
      expect(() =>
        buildQueryUrl({
          entitySet: 'Parts',
          filters: [{ property: "name eq 'x' or state", operator: 'eq', value: 'y' }],
        }),
      ).toThrow(/property/);
    });

    it('rejects $select entries that inject another parameter', () => {
      expect(() => buildQueryUrl({ entitySet: 'Parts', select: ['ID&$top=1'] })).toThrow(/\$select/);
      expect(() => buildQueryUrl({ entitySet: 'Parts', select: ['ID?$top=1'] })).toThrow(/\$select/);
    });

    it('rejects a sort field that injects filter logic', () => {
      expect(() => buildQueryUrl({ entitySet: 'Parts', orderBy: 'name&$top=9' })).toThrow(/\$orderby/);
      expect(() => buildQueryUrl({ entitySet: 'Parts', orderBy: 'name) or (1 eq 1' })).toThrow(
        /\$orderby/,
      );
    });

    it('rejects a navigation property that is not an identifier', () => {
      expect(() =>
        buildQueryUrl({ entitySet: 'Parts', expand: [{ navProperty: 'Docs($top=9)' }] }),
      ).toThrow(/navigation property/);
    });

    it('accepts navigation property paths and qualified names', () => {
      expect(buildQueryUrl({ entitySet: 'Parts', select: ['ID', 'number'] })).toBe(
        '/Parts?$select=ID,number',
      );
      expect(buildQueryUrl({ entitySet: 'Parts', filters: [{ property: 'a/b', operator: 'eq', value: '1' }] })).toBe(
        "/Parts?$filter=a/b eq 1",
      );
    });

    it('still warns (rather than throws) for valid-but-unknown properties', () => {
      const warnings: string[] = [];
      buildQueryUrl({
        entitySet: 'Parts',
        metadata,
        filters: [{ property: 'nope', operator: 'eq', value: '1' }],
        onWarning: (m) => warnings.push(m),
      });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('not a property');
    });
  });

  describe('in operator', () => {
    it('rejects an empty list instead of emitting invalid `in ()`', () => {
      expect(() =>
        buildQueryUrl({ entitySet: 'Parts', filters: [{ property: 'state', operator: 'in', value: '' }] }),
      ).toThrow(/non-empty/);
      expect(() =>
        buildQueryUrl({
          entitySet: 'Parts',
          filters: [{ property: 'state', operator: 'in', value: '()' }],
        }),
      ).toThrow(/non-empty/);
      expect(() =>
        buildQueryUrl({
          entitySet: 'Parts',
          filters: [{ property: 'state', operator: 'in', value: '( , , )' }],
        }),
      ).toThrow(/non-empty/);
    });

    it('rejects unbalanced parentheses instead of emitting broken OData', () => {
      expect(() =>
        buildQueryUrl({
          entitySet: 'Parts',
          filters: [{ property: 'state', operator: 'in', value: '(1,2' }],
        }),
      ).toThrow(/parenthes/i);
      expect(() =>
        buildQueryUrl({
          entitySet: 'Parts',
          filters: [{ property: 'state', operator: 'in', value: '1) or 1 eq 1 or (1' }],
        }),
      ).toThrow(/parenthes/i);
    });

    it('rejects a list that injects extra filter logic', () => {
      expect(() =>
        buildQueryUrl({
          entitySet: 'Parts',
          filters: [{ property: 'name', operator: 'in', value: "'a' or 1 eq 1" }],
        }),
      ).toThrow();
    });

    it('types list elements from the model instead of trusting the raw text', () => {
      // unitPrice is Edm.Decimal; quoted strings must be rejected like `eq` does.
      expect(() =>
        buildQueryUrl({
          entitySet: 'Parts',
          metadata,
          filters: [{ property: 'unitPrice', operator: 'in', value: "'abc','def'" }],
        }),
      ).toThrow(/Edm.Decimal/);

      const url = buildQueryUrl({
        entitySet: 'Parts',
        metadata,
        filters: [{ property: 'unitPrice', operator: 'in', value: '1, 2.5,3' }],
      });
      expect(url).toBe('/Parts?$filter=unitPrice in (1,2.5,3)');
    });

    it('round-trips quoted values without double-escaping', () => {
      const url = buildQueryUrl({
        entitySet: 'Parts',
        filters: [{ property: 'name', operator: 'in', value: "'O''Brien','Smith'" }],
      });
      expect(url).toBe("/Parts?$filter=name in ('O''Brien','Smith')");
    });

    it('keeps accepting the previously supported list shapes', () => {
      expect(
        buildQueryUrl({
          entitySet: 'Parts',
          filters: [{ property: 'state', operator: 'in', value: "'INWORK','RELEASED'" }],
        }),
      ).toBe("/Parts?$filter=state in ('INWORK','RELEASED')");

      expect(
        buildQueryUrl({
          entitySet: 'Parts',
          filters: [{ property: 'state', operator: 'in', value: "('A','B')" }],
        }),
      ).toBe("/Parts?$filter=state in ('A','B')");

      expect(
        buildQueryUrl({
          entitySet: 'Parts',
          metadata,
          filters: [{ property: 'state', operator: 'in', value: "'RELEASED'" }],
        }),
      ).toContain("state in (PTC.ProdMgmt.LifeCycleState'RELEASED')");
    });
  });

  describe('$orderby parsing', () => {
    it('no longer silently drops extra sort tokens', () => {
      expect(() => buildQueryUrl({ entitySet: 'Parts', orderBy: 'name desc garbage' })).toThrow(
        /\$orderby/,
      );
    });

    it('rejects a direction given without a field', () => {
      expect(() => buildQueryUrl({ entitySet: 'Parts', orderBy: ' desc' })).toThrow(/\$orderby/);
    });

    it('supports comma-separated multi-field sorting', () => {
      const url = buildQueryUrl({ entitySet: 'Parts', orderBy: 'name desc, number asc' });
      expect(url).toBe('/Parts?$orderby=name desc,number asc');
    });

    it('validates every field of a multi-field sort', () => {
      expect(() => buildQueryUrl({ entitySet: 'Parts', orderBy: 'name, number sideways' })).toThrow(
        'Invalid sort direction',
      );
    });
  });

  describe('nested $expand options', () => {
    it('rejects negative or non-integer $top/$skip, like the root level does', () => {
      expect(() =>
        buildQueryUrl({ entitySet: 'Parts', expand: [{ navProperty: 'Docs', top: -1 }] }),
      ).toThrow('Invalid $top');
      expect(() =>
        buildQueryUrl({ entitySet: 'Parts', expand: [{ navProperty: 'Docs', skip: -2 }] }),
      ).toThrow('Invalid $skip');
      expect(() =>
        buildQueryUrl({
          entitySet: 'Parts',
          metadata,
          expand: [{ navProperty: 'Documents', top: 1.5 }],
        }),
      ).toThrow('Invalid $top');
    });

    it('validates the nested sort expression', () => {
      expect(() =>
        buildQueryUrl({
          entitySet: 'Parts',
          expand: [{ navProperty: 'Docs', orderBy: 'name sideways' }],
        }),
      ).toThrow('Invalid sort direction');
      expect(() =>
        buildQueryUrl({
          entitySet: 'Parts',
          expand: [{ navProperty: 'Docs', orderBy: 'name&$top=9' }],
        }),
      ).toThrow(/\$orderby/);
    });

    it('validates deeply nested segments too', () => {
      expect(() =>
        buildQueryUrl({
          entitySet: 'Parts',
          metadata,
          expand: [
            { navProperty: 'Documents', expand: [{ navProperty: 'Describes', top: -3 }] },
          ],
        }),
      ).toThrow('Invalid $top');
    });

    it('still accepts valid nested options', () => {
      const url = buildQueryUrl({
        entitySet: 'Parts',
        metadata,
        expand: [{ navProperty: 'Documents', orderBy: 'name desc', top: 5, skip: 0 }],
      });
      expect(url).toBe('/Parts?$expand=Documents($orderby=name desc;$top=5;$skip=0)');
    });
  });
});
