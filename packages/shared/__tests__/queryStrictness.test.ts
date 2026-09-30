import { describe, it, expect } from 'vitest';
import { buildQueryUrl, formatV4Literal } from '../src/query.js';

/**
 * Strictness fixes for the resource-path key predicate, checked against the
 * OData V4.01 ABNF (oasis-tcs/odata-abnf, abnf/odata-abnf-construction-rules.txt):
 *
 *   keyPredicate = simpleKey / compoundKey / keyPathSegments
 *   simpleKey    = OPEN ( parameterAlias / keyPropertyValue ) CLOSE
 *   compoundKey  = OPEN keyValuePair *( COMMA keyValuePair ) CLOSE
 *   keyValuePair = ( primitiveKeyProperty / keyPropertyAlias )
 *                  EQ ( parameterAlias / keyPropertyValue )
 *
 *   keyPropertyValue = boolean / guid / dateTimeOffsetLiteral / date
 *                    / timeOfDayLiteral / decimalLiteral / sbyteLiteral / byte
 *                    / int16Literal / int32Literal / int64Literal
 *                    / stringLiteral / durationLiteral / enumLiteral
 *
 * Notably there is no nullValue alternative, and once a comma appears every
 * element must be a name=value pair — positional and named cannot be mixed.
 */
describe('key predicates: compound keys are all-or-nothing named', () => {
  it('rejects positional/named mixing, which no service accepts', () => {
    for (const entitySet of ["Parts(1,'x')", 'Parts(A=1,2)', 'Parts(A=1,B)', 'Parts(1,2)']) {
      expect(() => buildQueryUrl({ entitySet }), `expected ${entitySet} to be rejected`).toThrow(
        /entitySet/,
      );
    }
  });

  it('still accepts a fully named compound key and the single-key forms', () => {
    expect(buildQueryUrl({ entitySet: 'Parts(A=1,B=2)' })).toBe('/Parts(A=1,B=2)');
    expect(buildQueryUrl({ entitySet: 'Parts(ID=1)' })).toBe('/Parts(ID=1)');
    expect(buildQueryUrl({ entitySet: 'Parts(1)' })).toBe('/Parts(1)');
    expect(buildQueryUrl({ entitySet: "Parts('P1')" })).toBe("/Parts('P1')");
  });
});

describe('key predicates: null is not a keyPropertyValue', () => {
  it('rejects null in positional and named position', () => {
    expect(() => buildQueryUrl({ entitySet: 'Parts(null)' })).toThrow(/entitySet/);
    expect(() => buildQueryUrl({ entitySet: 'Parts(A=null)' })).toThrow(/entitySet/);
  });

  it('still accepts the boolean literals, which are in keyPropertyValue', () => {
    expect(buildQueryUrl({ entitySet: 'Parts(true)' })).toBe('/Parts(true)');
    expect(buildQueryUrl({ entitySet: 'Parts(A=false)' })).toBe('/Parts(A=false)');
  });
});

/**
 * A bare integer token is int64Literal = [ SIGN ] 1*19DIGIT with the int64
 * range as a semantic restriction. 20+ digits can never fit int64 (the
 * smallest 20-digit number exceeds 9223372036854775807), so a long token is
 * rejected on digit count and a 19-digit token on range.
 */
describe('key predicates: bare integers follow int64Literal', () => {
  it('rejects integers beyond 19 digits', () => {
    expect(() => buildQueryUrl({ entitySet: 'Parts(99999999999999999999999999)' })).toThrow(
      /entitySet/,
    );
  });

  it('rejects a 19-digit token outside the int64 range', () => {
    expect(() => buildQueryUrl({ entitySet: 'Parts(9223372036854775808)' })).toThrow(/entitySet/);
    expect(() => buildQueryUrl({ entitySet: 'Parts(-9223372036854775809)' })).toThrow(/entitySet/);
  });

  it('accepts both ends of the int64 range', () => {
    expect(buildQueryUrl({ entitySet: 'Parts(9223372036854775807)' })).toBe(
      '/Parts(9223372036854775807)',
    );
    expect(buildQueryUrl({ entitySet: 'Parts(-9223372036854775808)' })).toBe(
      '/Parts(-9223372036854775808)',
    );
  });
});

/**
 * The fourth case found while auditing: the old matcher accepted *any* bare
 * token from [A-Za-z0-9_.:+-]+ as a value, so identifiers and malformed
 * tokens that match no keyPropertyValue alternative produced URLs a service
 * rejects with 400 — including date/time shapes with out-of-range fields
 * (month 13, minute 70) and bare durations (durationLiteral requires quotes).
 */
describe('key predicates: unquoted values must be keyPropertyValue alternatives', () => {
  it('rejects bare identifiers and malformed tokens', () => {
    for (const entitySet of ['Parts(hello)', 'Parts(1+2)', 'Parts(1.2.3)', 'Parts(-)']) {
      expect(() => buildQueryUrl({ entitySet }), `expected ${entitySet} to be rejected`).toThrow(
        /entitySet/,
      );
    }
  });

  it('rejects out-of-range date and time fields', () => {
    expect(() => buildQueryUrl({ entitySet: 'Parts(2024-13-45)' })).toThrow(/entitySet/);
    expect(() => buildQueryUrl({ entitySet: 'Parts(12:70)' })).toThrow(/entitySet/);
  });

  it('rejects a bare duration; durationLiteral is quoted', () => {
    expect(() => buildQueryUrl({ entitySet: 'Parts(P1D)' })).toThrow(/entitySet/);
    // The quoted spelling stays valid (it is a plain string literal).
    expect(buildQueryUrl({ entitySet: "Parts('P1D')" })).toBe("/Parts('P1D')");
  });

  it('accepts the literal shapes the grammar does allow', () => {
    expect(buildQueryUrl({ entitySet: 'Parts(1.5)' })).toBe('/Parts(1.5)');
    expect(buildQueryUrl({ entitySet: 'Parts(12:30:00)' })).toBe('/Parts(12:30:00)');
    expect(buildQueryUrl({ entitySet: 'Parts(2024-01-15)' })).toBe('/Parts(2024-01-15)');
    expect(buildQueryUrl({ entitySet: 'Parts(2024-01-15T10:00:00Z)' })).toBe(
      '/Parts(2024-01-15T10:00:00Z)',
    );
    expect(buildQueryUrl({ entitySet: 'Parts(00000000-0000-0000-0000-000000000000)' })).toBe(
      '/Parts(00000000-0000-0000-0000-000000000000)',
    );
  });
});

/**
 * The quoted-value rules are deliberate and must not regress: %XX escapes are
 * allowed (also what the MCP key builder emits), while a raw / or \ would
 * change which resource the URL addresses, and space/#/?/& and control
 * characters would corrupt the URL.
 */
describe('key predicates: quoted-value safety must not regress', () => {
  it('rejects URL-breaking characters inside quotes', () => {
    for (const entitySet of [
      "Parts('a/b')",
      String.raw`Parts('a\b')`,
      "Parts('a b')",
      "Parts('a#b')",
      "Parts('a?b')",
      "Parts('a&b')",
      "Parts('50%')",
      "Parts('a%ZZb')",
      "Parts('a\u0000b')",
      'Parts()',
      "Parts('unbalanced)",
      "Parts('a') or (1 eq 1",
    ]) {
      expect(() => buildQueryUrl({ entitySet }), `expected ${entitySet} to be rejected`).toThrow(
        /entitySet/,
      );
    }
  });

  it('accepts percent escapes and doubled quotes', () => {
    expect(buildQueryUrl({ entitySet: "Parts('a%20b')" })).toBe("/Parts('a%20b')");
    expect(buildQueryUrl({ entitySet: "Parts(ID='a%2Fb')" })).toBe("/Parts(ID='a%2Fb')");
    expect(buildQueryUrl({ entitySet: "Parts('O''Brien')" })).toBe("/Parts('O''Brien')");
    // Comma and parentheses are legal inside a quoted value; the splitter must
    // not treat them as structure.
    expect(buildQueryUrl({ entitySet: "Parts('a,b')" })).toBe("/Parts('a,b')");
    expect(buildQueryUrl({ entitySet: "Parts('(1)')" })).toBe("/Parts('(1)')");
  });
});

/**
 * Number.isFinite tests binary64, so it was the wrong oracle for Edm.Single
 * (max 3.4028234663852886e38) and for Edm.Decimal (arbitrary precision, but
 * no mainstream OData service implements more than 38 digits).
 *
 * The Decimal bound is a *necessary condition*: any value with <= 38
 * significant digits has magnitude < 1e38, so nothing a precision-<=38
 * service can store is rejected — only literals no such service can store.
 */
describe('formatV4Literal: per-type upper bounds', () => {
  it('accepts both ends of the Edm.Single range', () => {
    expect(formatV4Literal('3.4028234663852886e38', 'Edm.Single')).toBe('3.4028234663852886e38');
    expect(formatV4Literal('-3.4028234663852886e38', 'Edm.Single')).toBe('-3.4028234663852886e38');
    expect(formatV4Literal('1e5', 'Edm.Single')).toBe('1e5');
  });

  it('rejects values past the Edm.Single range', () => {
    expect(() => formatV4Literal('1e39', 'Edm.Single')).toThrow(/range|finite/i);
    expect(() => formatV4Literal('3.4028235e38', 'Edm.Single')).toThrow(/range|finite/i);
    expect(() => formatV4Literal('-3.4028235e38', 'Edm.Single')).toThrow(/range|finite/i);
  });

  it('accepts both ends of the Edm.Decimal bound', () => {
    expect(formatV4Literal('9.9e37', 'Edm.Decimal')).toBe('9.9e37');
    expect(formatV4Literal('-9.9e37', 'Edm.Decimal')).toBe('-9.9e37');
    // 38 nines: the largest integer with <= 38 digits.
    expect(formatV4Literal('99999999999999999999999999999999999999', 'Edm.Decimal')).toBe(
      '99999999999999999999999999999999999999',
    );
    expect(formatV4Literal('1.5', 'Edm.Decimal')).toBe('1.5');
  });

  it('rejects large decimals that previously slipped through', () => {
    expect(() => formatV4Literal('1e38', 'Edm.Decimal')).toThrow(/range/i);
    expect(() => formatV4Literal('-1e38', 'Edm.Decimal')).toThrow(/range/i);
    expect(() => formatV4Literal('1e300', 'Edm.Decimal')).toThrow(/range/i);
    // 39 nines ~ 1e39.
    expect(() => formatV4Literal('999999999999999999999999999999999999999', 'Edm.Decimal')).toThrow(
      /range/i,
    );
  });

  it('keeps ABNF-legal long decimal literals that are in range', () => {
    // A 400-digit *fractional* literal is legal when Precision is unspecified
    // and fits the bound (its value is tiny); it must keep working.
    const tiny = `0.${'0'.repeat(399)}1`;
    expect(formatV4Literal(tiny, 'Edm.Decimal')).toBe(tiny);
  });

  it('rejects a 400-digit integer literal for Edm.Decimal (documented decision)', () => {
    // ABNF decimalLiteral has no digit cap, but no mainstream service
    // implements > 38 digits of precision; before this change it was rejected
    // too (as "not a finite number", via binary64 overflow) — now for a
    // documented range reason instead of an accident of float parsing.
    expect(() => formatV4Literal('9'.repeat(400), 'Edm.Decimal')).toThrow(/Edm\.Decimal/);
  });
});

/**
 * The ABNF spells the special values in decimalLiteral (shared by
 * doubleLiteral and singleLiteral):
 *
 *   decimalLiteral = [ SIGN ] 1*DIGIT [ "." 1*DIGIT ] [ "e" ... ] / nanInfinity
 *   nanInfinity    = "NaN" / "-INF" / "INF"
 *
 * so INF/-INF/NaN are legal for Edm.Double and Edm.Single and refusing them
 * was the same class of bug as accepting too much elsewhere. They are still
 * refused for Edm.Decimal (no decimal implementation can represent them) and
 * for the integer types (no rule admits them there).
 */
describe('formatV4Literal: INF/-INF/NaN decision', () => {
  it.each(['INF', '-INF', 'NaN'])('accepts %s for Edm.Double', (value) => {
    expect(formatV4Literal(value, 'Edm.Double')).toBe(value);
  });

  it.each(['INF', '-INF', 'NaN'])('accepts %s for Edm.Single', (value) => {
    expect(formatV4Literal(value, 'Edm.Single')).toBe(value);
  });

  it.each(['INF', '-INF', 'NaN'])('rejects %s for Edm.Decimal', (value) => {
    expect(() => formatV4Literal(value, 'Edm.Decimal')).toThrow(/Edm\.Decimal/);
    expect(() => formatV4Literal(value, 'Edm.Decimal')).toThrow(/NaN|INF/);
  });

  it('still rejects INF for Edm.Int64 and quotes it for Edm.String', () => {
    expect(() => formatV4Literal('INF', 'Edm.Int64')).toThrow(/integer/i);
    expect(formatV4Literal('INF', 'Edm.String')).toBe("'INF'");
  });
});

/**
 * The pre-existing floating-point checks must survive the rewrite: binary64
 * overflow in a Double literal, and the Single bound reached via overflow.
 */
describe('formatV4Literal: existing floating checks must not regress', () => {
  it('rejects a Double literal that overflows binary64', () => {
    expect(() => formatV4Literal('1e999', 'Edm.Double')).toThrow(/finite|range/i);
    expect(() => formatV4Literal('1e309', 'Edm.Double')).toThrow(/finite|range/i);
    expect(formatV4Literal('1.7976931348623157e308', 'Edm.Double')).toBe('1.7976931348623157e308');
  });

  it('rejects a Single literal that overflows', () => {
    expect(() => formatV4Literal('-1e999', 'Edm.Single')).toThrow(/finite|range/i);
  });
});
