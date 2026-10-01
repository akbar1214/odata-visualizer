import { describe, it, expect } from 'vitest';
import { buildQueryUrl } from '../src/query.js';

/**
 * A space is not legal raw in a URI: RFC 3986 defines
 * `query = *( pchar / "/" / "?" )` and `pchar` excludes it. `$filter` joins its
 * clauses with ` and `, and `$orderby` puts a space before the direction, so the
 * space is *structural* — every filter and every directional sort produced a URL
 * that `curl` rejected with exit 3, independent of the values involved.
 *
 * `[`, `]`, `{` and `}` are likewise outside `pchar`/`sub-delims`, and the
 * brackets double as curl glob delimiters.
 *
 * Encoding is safe because the server percent-decodes before parsing the system
 * query option, so `name%20eq%20'ball%20bearing'` is still valid OData.
 */
describe('system query options are percent-encoded', () => {
  it('encodes the structural spaces in $filter', () => {
    const url = buildQueryUrl({
      entitySet: 'Parts',
      filters: [{ property: 'name', operator: 'eq', value: 'ball bearing' }],
    });

    expect(url).toBe("/Parts?$filter=name%20eq%20'ball%20bearing'");
  });

  it('encodes the space before an $orderby direction', () => {
    expect(buildQueryUrl({ entitySet: 'Parts', orderBy: 'number desc' })).toBe(
      '/Parts?$orderby=number%20desc',
    );
  });

  it('encodes a multi-field $orderby without touching the commas', () => {
    expect(buildQueryUrl({ entitySet: 'Parts', orderBy: 'name desc, number asc' })).toBe(
      '/Parts?$orderby=name%20desc,number%20asc',
    );
  });

  it('encodes a nested $expand $orderby', () => {
    const url = buildQueryUrl({
      entitySet: 'Parts',
      expand: [{ navProperty: 'Documents', orderBy: 'name desc', top: 5, skip: 0 }],
    });

    expect(url).toBe('/Parts?$expand=Documents($orderby=name%20desc;$top=5;$skip=0)');
  });

  it('encodes $search, which has no structural space to hide behind', () => {
    expect(buildQueryUrl({ entitySet: 'Parts', search: 'ball bearing' })).toBe(
      '/Parts?$search=ball%20bearing',
    );
  });

  it('encodes brackets and braces, which are outside pchar and are curl glob delimiters', () => {
    const url = buildQueryUrl({
      entitySet: 'Parts',
      filters: [{ property: 'name', operator: 'eq', value: '[a]{b}' }],
    });

    expect(url).toBe("/Parts?$filter=name%20eq%20'%5Ba%5D%7Bb%7D'");
  });

  it('still encodes the characters that corrupt a query string', () => {
    const url = buildQueryUrl({
      entitySet: 'Parts',
      filters: [{ property: 'name', operator: 'eq', value: 'a%b&c#d+e' }],
    });

    expect(url).toBe("/Parts?$filter=name%20eq%20'a%25b%26c%23d%2Be'");
  });

  it('leaves characters that are legal raw in a query alone', () => {
    // Quotes, `=`, commas, semicolons, parentheses, `$`, `:`, `/` and `?` are
    // all `sub-delims` or `pchar` — encoding them would make the preview
    // unreadable for no gain.
    const url = buildQueryUrl({
      entitySet: 'Parts',
      filters: [{ property: 'name', operator: 'eq', value: "O'Brien, Jr." }],
    });

    // The quote inside the literal is doubled by OData escaping, not encoded.
    expect(url).toBe("/Parts?$filter=name%20eq%20'O''Brien,%20Jr.'");
  });
});

/**
 * `DEL` is outside `pchar` and has no visible effect in a terminal, so it is
 * the character most likely to slip through unnoticed. Deleting its branch from
 * the encoder survived both the shared and the MCP suite.
 */
describe('control characters are encoded', () => {
  it('encodes DEL, which is invisible in a terminal', () => {
    const url = buildQueryUrl({
      entitySet: 'Parts',
      filters: [{ property: 'name', operator: 'eq', value: 'a\u007fb' }],
    });

    expect(url).toBe("/Parts?$filter=name%20eq%20'a%7Fb'");
  });

  it('encodes a tab and a newline', () => {
    const url = buildQueryUrl({
      entitySet: 'Parts',
      filters: [{ property: 'name', operator: 'eq', value: 'a\tb\nc' }],
    });

    expect(url).toBe("/Parts?$filter=name%20eq%20'a%09b%0Ac'");
  });
});

/**
 * `curl` accepts these seven, so they never showed up in the reported bug — but
 * they are outside `pchar`/`sub-delims`, WHATWG `URL` encodes three of them, and
 * strict servers and WAFs reject the rest. MCP's `PATH_UNSAFE` already encoded
 * all seven, so the query side was the inconsistent one.
 */
describe('characters outside pchar that curl tolerates are still encoded', () => {
  it('encodes quotes, angle brackets, backslash, caret, backtick and pipe', () => {
    const url = buildQueryUrl({
      entitySet: 'Parts',
      filters: [{ property: 'name', operator: 'eq', value: 'a"b<c>d\\e^f`g|h' }],
    });

    expect(url).toBe("/Parts?$filter=name%20eq%20'a%22b%3Cc%3Ed%5Ce%5Ef%60g%7Ch'");
  });
});
