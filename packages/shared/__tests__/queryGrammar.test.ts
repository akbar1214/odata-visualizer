import { describe, it, expect } from 'vitest';
import { buildQueryUrl, formatV4Literal } from '../src/query.js';

/**
 * Integer literals were validated with the *floating*-point pattern
 * (`/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/`), so a fractional or exponent form was
 * accepted for an integral type and emitted verbatim. A service rejects
 * `Edm.Int32 eq 1.5`; the bug was that the builder never said so.
 */
describe('formatV4Literal: integral types', () => {
  it.each(['Edm.Byte', 'Edm.SByte', 'Edm.Int16', 'Edm.Int32', 'Edm.Int64'])(
    'rejects a fractional value for %s',
    (type) => {
      expect(() => formatV4Literal('1.5', type)).toThrow(/integer/i);
    },
  );

  it.each(['Edm.Byte', 'Edm.SByte', 'Edm.Int16', 'Edm.Int32', 'Edm.Int64'])(
    'rejects an exponent form for %s',
    (type) => {
      expect(() => formatV4Literal('1e5', type)).toThrow(/integer/i);
      expect(() => formatV4Literal('1E5', type)).toThrow(/integer/i);
    },
  );

  it('still accepts plain integers, including signed and zero', () => {
    expect(formatV4Literal('0', 'Edm.Int32')).toBe('0');
    expect(formatV4Literal('-42', 'Edm.Int32')).toBe('-42');
    expect(formatV4Literal('+7', 'Edm.Int32')).toBe('+7');
    expect(formatV4Literal('9223372036854775807', 'Edm.Int64')).toBe('9223372036854775807');
  });

  it('enforces the range of the bounded integer types', () => {
    expect(() => formatV4Literal('256', 'Edm.Byte')).toThrow(/range/i);
    expect(() => formatV4Literal('-1', 'Edm.Byte')).toThrow(/range/i);
    expect(() => formatV4Literal('128', 'Edm.SByte')).toThrow(/range/i);
    expect(() => formatV4Literal('32768', 'Edm.Int16')).toThrow(/range/i);
    expect(() => formatV4Literal('2147483648', 'Edm.Int32')).toThrow(/range/i);
    // Bounds themselves are valid.
    expect(formatV4Literal('255', 'Edm.Byte')).toBe('255');
    expect(formatV4Literal('-2147483648', 'Edm.Int32')).toBe('-2147483648');
  });

  it('range-checks Int64 beyond Number.MAX_SAFE_INTEGER', () => {
    expect(() => formatV4Literal('9223372036854775808', 'Edm.Int64')).toThrow(/range/i);
    expect(formatV4Literal('-9223372036854775808', 'Edm.Int64')).toBe('-9223372036854775808');
  });

  it('leaves the floating types alone', () => {
    expect(formatV4Literal('1.5', 'Edm.Double')).toBe('1.5');
    expect(formatV4Literal('1e5', 'Edm.Double')).toBe('1e5');
    expect(formatV4Literal('1.5', 'Edm.Decimal')).toBe('1.5');
    expect(formatV4Literal('1e5', 'Edm.Single')).toBe('1e5');
  });

  it('rejects a literal that overflows a floating type to infinity', () => {
    // `1e999` parses to Infinity: syntactically a number, not a usable literal.
    expect(() => formatV4Literal('1e999', 'Edm.Double')).toThrow(/finite|range/i);
    expect(() => formatV4Literal('-1e999', 'Edm.Single')).toThrow(/finite|range/i);
  });
});

/**
 * `$select` used the identifier matcher rather than the property-path one, so
 * it rejected `*` and every structural path — the two most common select shapes
 * in practice, and the ones an LLM asks for first.
 */
describe('buildQueryUrl: $select grammar', () => {
  it('accepts a bare star', () => {
    expect(buildQueryUrl({ entitySet: 'Parts', select: ['*'] })).toBe('/Parts?$select=*');
  });

  it('accepts an all-operations wildcard', () => {
    expect(buildQueryUrl({ entitySet: 'Parts', select: ['NS.*'] })).toBe('/Parts?$select=NS.*');
  });

  it('accepts a structural property path', () => {
    expect(buildQueryUrl({ entitySet: 'Parts', select: ['Address/City'] })).toBe(
      '/Parts?$select=Address/City',
    );
  });

  it('accepts a type-qualified path', () => {
    expect(buildQueryUrl({ entitySet: 'Parts', select: ['NS.Part/Name'] })).toBe(
      '/Parts?$select=NS.Part/Name',
    );
  });

  it('accepts a deep structural path', () => {
    expect(buildQueryUrl({ entitySet: 'Parts', select: ['A/B/C'] })).toBe('/Parts?$select=A/B/C');
  });

  it('still rejects something that is not a select item', () => {
    expect(() => buildQueryUrl({ entitySet: 'Parts', select: ['ID&$top=1'] })).toThrow(/\$select/);
    expect(() => buildQueryUrl({ entitySet: 'Parts', select: [''] })).toThrow(/\$select/);
    expect(() => buildQueryUrl({ entitySet: 'Parts', select: ['A//B'] })).toThrow(/\$select/);
  });
});

/**
 * An entity set can be addressed with a key predicate — `/Parts('P1')` is the
 * single most common URL anyone types into an OData tool — but the resource
 * segment matcher rejected the parentheses outright.
 */
describe('buildQueryUrl: key predicates', () => {
  it('accepts a single positional key', () => {
    expect(buildQueryUrl({ entitySet: "Parts('P1')" })).toBe("/Parts('P1')");
    expect(buildQueryUrl({ entitySet: 'Parts(1)', top: 5 })).toBe('/Parts(1)?$top=5');
  });

  it('accepts a named key and a composite key', () => {
    expect(buildQueryUrl({ entitySet: 'Parts(ID=1)' })).toBe('/Parts(ID=1)');
    expect(buildQueryUrl({ entitySet: "Parts(A=1,B='x')" })).toBe("/Parts(A=1,B='x')");
  });

  it('keeps an escaped quote inside a key value', () => {
    expect(buildQueryUrl({ entitySet: "Parts('O''Brien')" })).toBe("/Parts('O''Brien')");
  });

  it('keeps raw + and ; verbatim instead of refusing them', () => {
    // A deliberate choice: stringLiteral admits both through `other-delims`, so
    // the caller's spelling is preserved. The stack-specific reading of either
    // character is the caller's to handle.
    expect(buildQueryUrl({ entitySet: "Parts('a+b')" })).toBe("/Parts('a+b')");
    expect(buildQueryUrl({ entitySet: "Parts('a;b')" })).toBe("/Parts('a;b')");
    expect(buildQueryUrl({ entitySet: "Parts('a%2Bb')" })).toBe("/Parts('a%2Bb')");
    expect(buildQueryUrl({ entitySet: "Parts('a%3Bb')" })).toBe("/Parts('a%3Bb')");
    expect(() => buildQueryUrl({ entitySet: "Parts('a b')" })).toThrow(/entitySet/);
  });

  it('accepts a key on a container-qualified path', () => {
    expect(buildQueryUrl({ entitySet: "Container/Parts('P1')" })).toBe("/Container/Parts('P1')");
  });

  it('rejects a predicate that would break the URL', () => {
    for (const entitySet of [
      "Parts('a b')",
      "Parts('a#b')",
      "Parts('a?b')",
      "Parts('a%b')",
      "Parts('a&b')",
      "Parts('a') or (1 eq 1",
      'Parts()',
      "Parts('unbalanced)",
    ]) {
      expect(() => buildQueryUrl({ entitySet }), `expected ${entitySet} to be rejected`).toThrow(
        /entitySet/,
      );
    }
  });
});

/**
 * `/Parts('P1')` addresses one entity of the same set as `/Parts`, so metadata
 * resolution must look the set up by its path. Resolving the whole string found
 * nothing, which silently downgraded every literal to an inferred type and
 * switched property warnings off — a plausible URL that a service rejects.
 */
describe('key predicates keep metadata-based typing', () => {
  const csdl = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EnumType Name="State"><Member Name="ACTIVE" /></EnumType>
      <EntityType Name="Part">
        <Key><PropertyRef Name="ID" /></Key>
        <Property Name="ID" Type="Edm.String" Nullable="false" />
        <Property Name="Released" Type="Edm.DateTimeOffset" />
        <Property Name="State" Type="N.State" />
        <Property Name="Size" Type="Edm.Int32" />
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Parts" EntityType="N.Part" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

  it('types literals the same with and without a key predicate', async () => {
    const { parseCSDL } = await import('../src/parser.js');
    const metadata = await parseCSDL(csdl);

    const filters = [
      { property: 'Released', operator: 'gt', value: '2024-01-02T00:00:00Z' },
      { property: 'State', operator: 'eq', value: 'ACTIVE' },
      { property: 'Size', operator: 'gt', value: '10' },
    ];

    const plain = buildQueryUrl({ entitySet: 'Parts', metadata, filters });
    const keyed = buildQueryUrl({ entitySet: "Parts('P1')", metadata, filters });

    // The only difference must be the resource path.
    expect(plain).toBe(
      "/Parts?$filter=Released%20gt%202024-01-02T00:00:00Z%20and%20State%20eq%20N.State'ACTIVE'%20and%20Size%20gt%2010",
    );
    expect(keyed).toBe(plain.replace('/Parts?', "/Parts('P1')?"));
  });

  it('still warns about an unknown property on a keyed path', async () => {
    const { parseCSDL } = await import('../src/parser.js');
    const metadata = await parseCSDL(csdl);
    const warnings: string[] = [];

    buildQueryUrl({
      entitySet: "Parts('P1')",
      metadata,
      filters: [{ property: 'Nope', operator: 'eq', value: '1' }],
      onWarning: (message) => warnings.push(message),
    });

    expect(warnings).toEqual(['"Nope" is not a property of N.Part.']);
  });
});

/**
 * `*` and structural paths are not property names on the root type, so the
 * exact-name warning check cannot apply. It fired for every non-trivial select
 * once the grammar accepted them, which made the headline `$select=*` case look
 * like a mistake to an MCP client.
 */
describe('$select wildcards and paths produce no property warning', () => {
  it('stays silent for *, NS.* and structural paths', async () => {
    const { parseCSDL } = await import('../src/parser.js');
    const metadata = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <ComplexType Name="Addr"><Property Name="City" Type="Edm.String" /></ComplexType>
      <EntityType Name="Part">
        <Key><PropertyRef Name="ID" /></Key>
        <Property Name="ID" Type="Edm.String" Nullable="false" />
        <Property Name="Where" Type="N.Addr" />
      </EntityType>
      <EntityContainer Name="Container"><EntitySet Name="Parts" EntityType="N.Part" /></EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);

    const warnings: string[] = [];
    buildQueryUrl({
      entitySet: 'Parts',
      metadata,
      select: ['*', 'N.*', 'Where/City', 'N.Part/ID'],
      onWarning: (message) => warnings.push(message),
    });

    expect(warnings).toEqual([]);
  });

  it('still warns for a plain unknown property name', async () => {
    const { parseCSDL } = await import('../src/parser.js');
    const metadata = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Part">
        <Key><PropertyRef Name="ID" /></Key>
        <Property Name="ID" Type="Edm.String" Nullable="false" />
      </EntityType>
      <EntityContainer Name="Container"><EntitySet Name="Parts" EntityType="N.Part" /></EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);

    const warnings: string[] = [];
    buildQueryUrl({
      entitySet: 'Parts',
      metadata,
      select: ['Nmae'],
      onWarning: (message) => warnings.push(message),
    });

    expect(warnings).toEqual(['"Nmae" is not a property of N.Part.']);
  });
});

/** The nested `$expand` select uses the same V4 grammar as the root one. */
describe('$expand select grammar', () => {
  it('accepts wildcards and paths inside an expand', () => {
    const url = buildQueryUrl({
      entitySet: 'Parts',
      expand: [{ navProperty: 'Docs', select: ['*', 'Where/City'] }],
    });
    expect(url).toBe('/Parts?$expand=Docs($select=*,Where/City)');
  });

  it('rejects an injection attempt inside an expand select', () => {
    expect(() =>
      buildQueryUrl({
        entitySet: 'Parts',
        expand: [{ navProperty: 'Docs', select: ['ID&$top=1'] }],
      }),
    ).toThrow(/\$select/);
  });
});

/** The bounded integer types have four corners each; only two were covered. */
describe('integer range boundaries', () => {
  it.each([
    ['Edm.Byte', '0', '255'],
    ['Edm.SByte', '-128', '127'],
    ['Edm.Int16', '-32768', '32767'],
    ['Edm.Int32', '-2147483648', '2147483647'],
    ['Edm.Int64', '-9223372036854775808', '9223372036854775807'],
  ])('accepts both ends of %s', (type, min, max) => {
    expect(formatV4Literal(min, type)).toBe(min);
    expect(formatV4Literal(max, type)).toBe(max);
  });

  it.each([
    ['Edm.Byte', '-1', '256'],
    ['Edm.SByte', '-129', '128'],
    ['Edm.Int16', '-32769', '32768'],
    ['Edm.Int32', '-2147483649', '2147483648'],
    ['Edm.Int64', '-9223372036854775809', '9223372036854775808'],
  ])('rejects one past each end of %s', (type, below, above) => {
    expect(() => formatV4Literal(below, type)).toThrow(/range/i);
    expect(() => formatV4Literal(above, type)).toThrow(/range/i);
  });

  it('trims surrounding whitespace for a numeric literal', () => {
    expect(formatV4Literal(' 7 ', 'Edm.Int32')).toBe('7');
    expect(formatV4Literal(' 1.5 ', 'Edm.Double')).toBe('1.5');
  });
});

/**
 * A raw `/` inside a quoted key value is the path separator, so the URL
 * addresses a different resource; `%XX` is the legal spelling and is also what
 * the MCP key builder emits.
 */
describe('key predicate value safety', () => {
  it('rejects a raw slash and a backslash', () => {
    expect(() => buildQueryUrl({ entitySet: "Parts('a/b')" })).toThrow(/entitySet/);
    // WHATWG URL normalizes `\` to `/`, so it would change the path too.
    expect(() => buildQueryUrl({ entitySet: String.raw`Parts('a\b')` })).toThrow(/entitySet/);
  });

  it('rejects control characters', () => {
    expect(() => buildQueryUrl({ entitySet: "Parts('a\u0000b')" })).toThrow(/entitySet/);
    expect(() => buildQueryUrl({ entitySet: "Parts('a\tb')" })).toThrow(/entitySet/);
  });

  it('accepts a percent-encoded value, which is the legal spelling', () => {
    expect(buildQueryUrl({ entitySet: "Parts('a%20b')" })).toBe("/Parts('a%20b')");
    expect(buildQueryUrl({ entitySet: "Parts(ID='a%2Fb')" })).toBe("/Parts(ID='a%2Fb')");
    // A bare `%` that is not a valid escape stays rejected.
    expect(() => buildQueryUrl({ entitySet: "Parts('50%')" })).toThrow(/entitySet/);
    expect(() => buildQueryUrl({ entitySet: "Parts('a%ZZb')" })).toThrow(/entitySet/);
  });
});
