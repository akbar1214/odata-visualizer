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
