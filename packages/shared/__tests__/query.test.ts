import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCSDL } from '../src/parser.js';
import { buildQueryUrl, formatV4Literal } from '../src/query.js';

const windchillCSDL = readFileSync(
  fileURLToPath(new URL('./fixtures/windchill-prodmgmt.xml', import.meta.url)),
  'utf-8',
);

describe('formatV4Literal', () => {
  it('quotes and escapes strings', () => {
    expect(formatV4Literal("O'Brien")).toBe("'O''Brien'");
    expect(formatV4Literal('')).toBe("''");
  });

  it('emits bare booleans and numbers', () => {
    expect(formatV4Literal('true', 'Edm.Boolean')).toBe('true');
    expect(formatV4Literal('42', 'Edm.Int32')).toBe('42');
    expect(formatV4Literal('4.2', 'Edm.Decimal')).toBe('4.2');
    expect(formatV4Literal('42')).toBe('42'); // inferred numeric
  });

  it('rejects invalid numbers and booleans', () => {
    expect(() => formatV4Literal('abc', 'Edm.Int32')).toThrow('Invalid Edm.Int32');
    expect(() => formatV4Literal('yes', 'Edm.Boolean')).toThrow('Invalid boolean');
  });

  it('emits bare ISO dates (no datetime prefix)', () => {
    expect(formatV4Literal('2024-01-15T10:00:00Z', 'Edm.DateTimeOffset')).toBe(
      '2024-01-15T10:00:00Z',
    );
    expect(formatV4Literal('2024-01-15', 'Edm.Date')).toBe('2024-01-15');
  });

  it('emits bare guids (no guid prefix)', () => {
    expect(formatV4Literal('01234567-89ab-cdef-0123-456789abcdef', 'Edm.Guid')).toBe(
      '01234567-89ab-cdef-0123-456789abcdef',
    );
    expect(() => formatV4Literal('not-a-guid', 'Edm.Guid')).toThrow('Invalid Edm.Guid');
  });

  it('emits qualified enum literals for named types', () => {
    expect(formatV4Literal('RELEASED', 'PTC.ProdMgmt.LifeCycleState')).toBe(
      "PTC.ProdMgmt.LifeCycleState'RELEASED'",
    );
  });

  it('emits null for non-string null input', () => {
    expect(formatV4Literal('null', 'Edm.Int32')).toBe('null');
    expect(formatV4Literal('null', 'Edm.String')).toBe("'null'");
  });
});

describe('buildQueryUrl', () => {
  it('builds a bare resource path', () => {
    expect(buildQueryUrl({ entitySet: 'Parts' })).toBe('/Parts');
  });

  it('builds $filter with typed literals using metadata', async () => {
    const metadata = await parseCSDL(windchillCSDL);
    const url = buildQueryUrl({
      entitySet: 'Parts',
      metadata,
      filters: [
        { property: 'number', operator: 'eq', value: 'W-123' },
        { property: 'unitPrice', operator: 'gt', value: '10.5' },
        { property: 'hasCAD', operator: 'eq', value: 'true' },
        { property: 'releaseDate', operator: 'ge', value: '2024-01-01T00:00:00Z' },
      ],
      filterLogic: 'and',
    });
    expect(url).toBe(
      "/Parts?$filter=number eq 'W-123' and unitPrice gt 10.5 and hasCAD eq true and releaseDate ge 2024-01-01T00:00:00Z",
    );
  });

  it('emits enum literals for enum-typed properties', async () => {
    const metadata = await parseCSDL(windchillCSDL);
    const url = buildQueryUrl({
      entitySet: 'Parts',
      metadata,
      filters: [{ property: 'state', operator: 'eq', value: 'RELEASED' }],
    });
    expect(url).toContain(
      "state eq PTC.ProdMgmt.LifeCycleState'RELEASED'",
    );
  });

  it('builds string functions', async () => {
    const url = buildQueryUrl({
      entitySet: 'Parts',
      filters: [
        { property: 'number', operator: 'contains', value: 'W-1' },
        { property: 'name', operator: 'startswith', value: 'Pump' },
      ],
      filterLogic: 'and',
    });
    expect(url).toBe("/Parts?$filter=contains(number,'W-1') and startswith(name,'Pump')");
  });

  it('supports in expressions with raw lists', () => {
    const url = buildQueryUrl({
      entitySet: 'Parts',
      filters: [{ property: 'state', operator: 'in', value: "'INWORK','RELEASED'" }],
    });
    expect(url).toBe("/Parts?$filter=state in ('INWORK','RELEASED')");
  });

  it('builds select, orderby, paging, and count', () => {
    const url = buildQueryUrl({
      entitySet: 'Parts',
      select: ['ID', 'number', 'state'],
      orderBy: 'number desc',
      top: 10,
      skip: 20,
      count: true,
    });
    expect(url).toBe(
      '/Parts?$select=ID,number,state&$orderby=number desc&$top=10&$skip=20&$count=true',
    );
  });

  it('rejects invalid sort directions and paging values', () => {
    expect(() => buildQueryUrl({ entitySet: 'Parts', orderBy: 'number sideways' })).toThrow(
      'Invalid sort direction',
    );
    expect(() => buildQueryUrl({ entitySet: 'Parts', top: -1 })).toThrow('Invalid $top');
    expect(() =>
      buildQueryUrl({ entitySet: 'Parts', filters: [{ property: 'x', operator: 'like', value: 'y' }] }),
    ).toThrow('Unsupported filter operator');
  });

  it('builds nested $expand with segment options', async () => {
    const metadata = await parseCSDL(windchillCSDL);
    const url = buildQueryUrl({
      entitySet: 'Parts',
      metadata,
      select: ['ID', 'number'],
      expand: [
        {
          navProperty: 'Documents',
          select: ['ID', 'number'],
          filters: [{ property: 'name', operator: 'contains', value: 'draw' }],
          top: 5,
          expand: [
            {
              navProperty: 'Describes',
              select: ['ID', 'number'],
            },
          ],
        },
      ],
    });
    expect(url).toBe(
      "/Parts?$select=ID,number&$expand=Documents($select=ID,number;$filter=contains(name,'draw');$expand=Describes($select=ID,number);$top=5)",
    );
  });

  it('prefixes baseUrl when provided', () => {
    const url = buildQueryUrl({
      entitySet: 'Parts',
      baseUrl: 'https://windchill.example.com/Windchill/servlet/odata/ProdMgmt/',
      top: 5,
    });
    expect(url).toBe(
      'https://windchill.example.com/Windchill/servlet/odata/ProdMgmt/Parts?$top=5',
    );
  });

  it('validates expand nav properties resolve when metadata is present', async () => {
    const metadata = await parseCSDL(windchillCSDL);
    const url = buildQueryUrl({
      entitySet: 'Parts',
      metadata,
      expand: [{ navProperty: 'Documents', filters: [{ property: 'name', operator: 'eq', value: 'x' }] }],
    });
    // Documents targets CADDocument whose `name` is Edm.String → quoted
    expect(url).toContain("$expand=Documents($filter=name eq 'x')");
  });

  it('percent-encodes characters that would break the query string', () => {
    const url = buildQueryUrl({
      entitySet: 'Parts',
      filters: [{ property: 'number', operator: 'eq', value: 'A&B#1+C' }],
    });
    // Only the characters that would corrupt parsing are encoded; the
    // OData structure stays readable.
    expect(url).toBe("/Parts?$filter=number eq 'A%26B%231%2BC'");
  });

  it('encodes $search values', () => {
    const url = buildQueryUrl({ entitySet: 'Parts', search: 'red & blue' });
    expect(url).toBe('/Parts?$search=red %26 blue');
  });

  it('encodes the sort field but keeps the direction readable', () => {
    const url = buildQueryUrl({ entitySet: 'Parts', orderBy: 'name asc' });
    expect(url).toBe('/Parts?$orderby=name asc');
  });

  it('rejects $search combined with $filter, $top, or $skip', () => {
    expect(() =>
      buildQueryUrl({
        entitySet: 'Parts',
        search: 'red',
        filters: [{ property: 'name', operator: 'eq', value: 'x' }],
      }),
    ).toThrow('$search');

    expect(() => buildQueryUrl({ entitySet: 'Parts', search: 'red', top: 5 })).toThrow('$search');
    expect(() => buildQueryUrl({ entitySet: 'Parts', search: 'red', skip: 5 })).toThrow('$search');
  });

  it('allows $search together with $select, $orderby, and $count', () => {
    const url = buildQueryUrl({
      entitySet: 'Parts',
      search: 'red',
      select: ['ID'],
      orderBy: 'number',
      count: true,
    });
    expect(url).toBe('/Parts?$select=ID&$orderby=number&$count=true&$search=red');
  });
});
