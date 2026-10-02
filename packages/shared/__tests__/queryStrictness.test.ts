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
 * A bare integer token is either int64Literal = [ SIGN ] 1*19DIGIT, with the
 * int64 range as a semantic restriction, or decimalLiteral = [ SIGN ] 1*DIGIT,
 * which has no digit cap and no range. A token of at most 19 digits is treated
 * as an int64Literal and must be in range; a longer token is not an
 * int64Literal at all, so it falls through to the decimalLiteral alternative,
 * which accepts it. The old check applied the 19-digit cap *before* the
 * decimal test and so rejected ABNF-valid spellings such as
 * `Parts(000000000000000000000000001)`.
 */
describe('key predicates: bare integers are int64Literal or decimalLiteral', () => {
  it('accepts integer spellings longer than 19 digits as decimalLiteral', () => {
    // 27 digits whose value is 1: valid only as a decimalLiteral, and the case
    // that distinguishes the digit cap from the int64 range check.
    expect(buildQueryUrl({ entitySet: 'Parts(000000000000000000000000001)' })).toBe(
      '/Parts(000000000000000000000000001)',
    );
    expect(buildQueryUrl({ entitySet: 'Parts(99999999999999999999999999)' })).toBe(
      '/Parts(99999999999999999999999999)',
    );
    expect(buildQueryUrl({ entitySet: 'Parts(00000000000000000000000000000000)' })).toBe(
      '/Parts(00000000000000000000000000000000)',
    );
    expect(buildQueryUrl({ entitySet: 'Parts(99999999999999999999999999.0)' })).toBe(
      '/Parts(99999999999999999999999999.0)',
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
    // Month and day bounds checked on their own: with 2024-13-45 the invalid
    // day masks a broken month check, and there was no hour or second case.
    expect(() => buildQueryUrl({ entitySet: 'Parts(2024-13-01)' })).toThrow(/entitySet/);
    expect(() => buildQueryUrl({ entitySet: 'Parts(2024-01-32)' })).toThrow(/entitySet/);
    expect(() => buildQueryUrl({ entitySet: 'Parts(12:70)' })).toThrow(/entitySet/);
    expect(() => buildQueryUrl({ entitySet: 'Parts(12:30:61)' })).toThrow(/entitySet/);
    expect(() => buildQueryUrl({ entitySet: 'Parts(24:00)' })).toThrow(/entitySet/);
  });

  it('rejects calendar-invalid dates that pass the numeric field ranges', () => {
    // 02-31, 04-31 and a non-leap 02-29 all satisfy month 1-12 and day 1-31,
    // so only a real calendar round-trip catches them.
    for (const entitySet of ['Parts(2024-02-31)', 'Parts(2024-04-31)', 'Parts(2023-02-29)']) {
      expect(() => buildQueryUrl({ entitySet }), `expected ${entitySet} to be rejected`).toThrow(
        /entitySet/,
      );
    }

    // The check must not reject dates that do exist.
    expect(buildQueryUrl({ entitySet: 'Parts(2024-02-29)' })).toBe('/Parts(2024-02-29)');
    expect(buildQueryUrl({ entitySet: 'Parts(2024-12-31)' })).toBe('/Parts(2024-12-31)');
  });

  it('applies the calendar check to date-time tokens too', () => {
    expect(() => buildQueryUrl({ entitySet: 'Parts(2024-02-31T10:00:00Z)' })).toThrow(/entitySet/);
    expect(() => buildQueryUrl({ entitySet: 'Parts(2023-02-29T10:00:00Z)' })).toThrow(/entitySet/);
    expect(buildQueryUrl({ entitySet: 'Parts(2024-02-29T10:00:00Z)' })).toBe(
      '/Parts(2024-02-29T10:00:00Z)',
    );
  });

  it('rejects a bare duration; durationLiteral is quoted', () => {
    expect(() => buildQueryUrl({ entitySet: 'Parts(P1D)' })).toThrow(/entitySet/);
    // The quoted spelling stays valid (it is a plain string literal).
    expect(buildQueryUrl({ entitySet: "Parts('P1D')" })).toBe("/Parts('P1D')");
  });

  it('accepts the literal shapes the grammar does allow', () => {
    expect(buildQueryUrl({ entitySet: 'Parts(1.5)' })).toBe('/Parts(1.5)');
    // The exponent marker is `e`/`E` in decimalLiteral; `1E5` must not be
    // rejected because the check only recognised the lowercase spelling.
    expect(buildQueryUrl({ entitySet: 'Parts(1E5)' })).toBe('/Parts(1E5)');
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
 * change which resource the URL addresses, and space/#/? and control
 * characters would corrupt the URL. A raw `&` is legal (`pchar-no-SQUOTE`)
 * and accepted — see `queryGrammar.test.ts`.
 */
describe('key predicates: quoted-value safety must not regress', () => {
  it('rejects URL-breaking characters inside quotes', () => {
    for (const entitySet of [
      "Parts('a/b')",
      String.raw`Parts('a\b')`,
      "Parts('a b')",
      "Parts('a#b')",
      "Parts('a?b')",
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
 * SQUOTE = "'" / "%27": the ABNF makes the two spellings one token, so `%27`
 * may open, close or (doubled) escape a quoted value. Treating `%27` as
 * ordinary content let `Parts('a%27b')` through, which decodes to the invalid
 * literal `'a'b'`, and made the official test case `%27O'%27Neil'` fail.
 */
describe('key predicates: %27 is a quote, not content', () => {
  it('treats %27 exactly like a quote', () => {
    expect(buildQueryUrl({ entitySet: 'Parts(%27P1%27)' })).toBe('/Parts(%27P1%27)');
    expect(buildQueryUrl({ entitySet: "Parts('O%27%27Brien')" })).toBe("/Parts('O%27%27Brien')");
    // Official ABNF case: %27O'%27Neil' is the string O'Neil.
    expect(buildQueryUrl({ entitySet: "Parts(%27O'%27Neil')" })).toBe("/Parts(%27O'%27Neil')");
  });

  it('rejects an unpaired %27 that would close the value early', () => {
    expect(() => buildQueryUrl({ entitySet: "Parts('a%27b')" })).toThrow(/entitySet/);
    expect(() => buildQueryUrl({ entitySet: "Parts('a%27')" })).toThrow(/entitySet/);
    // Official ABNF case: 'O%27Neil' does not terminate.
    expect(() => buildQueryUrl({ entitySet: "Parts('O%27Neil')" })).toThrow(/entitySet/);
  });

  it('accepts %22, which pct-encoded-no-SQUOTE admits', () => {
    // Only %27 is excluded: the ABNF puts %2x in a second alternative whose
    // only excluded second digit is 7, so %22 was wrongly refused.
    expect(buildQueryUrl({ entitySet: "Parts('a%22b')" })).toBe("/Parts('a%22b')");
  });

  it('rejects percent escapes outside pct-encoded-no-SQUOTE', () => {
    // pct-encoded-no-SQUOTE admits %20-%26 and %28-%2F, but not %27 (a quote,
    // covered above) and not %70-%7F.
    for (const entitySet of ["Parts('a%70b')", "Parts('a%7Fb')", "Parts('a%7ab')"]) {
      expect(() => buildQueryUrl({ entitySet }), `expected ${entitySet} to be rejected`).toThrow(
        /entitySet/,
      );
    }
  });
});

/**
 * `Number.isFinite` tests binary64, so it was the wrong oracle for Edm.Single
 * (max 3.4028234663852886e38). `Math.fround` answers the actual question: does
 * the value round to a finite binary32? `3.4028235e38` is what .NET prints for
 * float.MaxValue and must round-trip, even though it is a binary64 value above
 * FLT_MAX.
 *
 * The Decimal bound is a *deliberate product cap*, not a grammar rule: CSDL
 * sets no digit limit and `Precision="floating"` permits values like
 * `9.999999e96`, while the 38-digit cap matches what mainstream fixed-precision
 * stores can hold. Precision/Scale facets are not consulted.
 */
describe('formatV4Literal: per-type upper bounds', () => {
  it('accepts both ends of the Edm.Single range', () => {
    expect(formatV4Literal('3.4028234663852886e38', 'Edm.Single')).toBe('3.4028234663852886e38');
    expect(formatV4Literal('-3.4028234663852886e38', 'Edm.Single')).toBe('-3.4028234663852886e38');
    expect(formatV4Literal('1e5', 'Edm.Single')).toBe('1e5');
  });

  it('accepts float.MaxValue as .NET emits it', () => {
    // 3.4028235e38 rounds to FLT_MAX in binary32; a service returning
    // float.MaxValue writes exactly this, so refusing it breaks round-trips.
    expect(formatV4Literal('3.4028235e38', 'Edm.Single')).toBe('3.4028235e38');
    expect(formatV4Literal('-3.4028235e38', 'Edm.Single')).toBe('-3.4028235e38');
  });

  it('rejects values past the Edm.Single range', () => {
    expect(() => formatV4Literal('1e39', 'Edm.Single')).toThrow(/range|finite/i);
    expect(() => formatV4Literal('3.4028236e38', 'Edm.Single')).toThrow(/range|finite/i);
    expect(() => formatV4Literal('-3.4028236e38', 'Edm.Single')).toThrow(/range|finite/i);
  });

  it('accepts both ends of the Edm.Decimal bound', () => {
    expect(formatV4Literal('9.9e37', 'Edm.Decimal')).toBe('9.9e37');
    expect(formatV4Literal('-9.9e37', 'Edm.Decimal')).toBe('-9.9e37');
    // 38 nines: the largest integer with <= 38 digits.
    expect(formatV4Literal('99999999999999999999999999999999999999', 'Edm.Decimal')).toBe(
      '99999999999999999999999999999999999999',
    );
    expect(formatV4Literal('1.5', 'Edm.Decimal')).toBe('1.5');
    // Zero times any power of ten is zero; the digit count of the exponent
    // must not be allowed to turn it into an out-of-range value.
    expect(formatV4Literal('0e1000', 'Edm.Decimal')).toBe('0e1000');
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
