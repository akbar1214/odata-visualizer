import { describe, it, expect } from 'vitest';
import { buildQueryUrl } from '../src/query.js';

/**
 * `baseUrl` is a URL prefix, not data, so it is validated rather than encoded.
 * Splicing it verbatim produced three distinct failures, all silent:
 *
 *   https://host/a b      -> curl exit 3 (malformed URL)
 *   https://host/svc#frag -> curl exit 6, but curl sends `GET /svc`: everything
 *                            after the `#` is a fragment, so the request lands
 *                            on the wrong resource without any error
 *   https://host/svc?x=1  -> the resource path folds into the query string,
 *                            so `GET /svc?x=1/Parts` addresses `/svc`
 *
 * `new URL()` alone is not enough to catch the first and last of those: it
 * percent-encodes a raw space in a path (`https://host/a%20b`) and silently
 * strips tab, newline and carriage return. Those are rejected explicitly, so a
 * baseUrl is either used exactly as written or refused — never quietly
 * rewritten.
 */
describe('baseUrl is validated, not spliced verbatim', () => {
  it('rejects a raw space, which makes curl reject the whole URL', () => {
    expect(() => buildQueryUrl({ entitySet: 'Parts', baseUrl: 'https://host/a b' })).toThrow(
      /Invalid baseUrl/,
    );
  });

  it('rejects a fragment marker, which would silently truncate the request path', () => {
    expect(() => buildQueryUrl({ entitySet: 'Parts', baseUrl: 'https://host/svc#frag' })).toThrow(
      /Invalid baseUrl/,
    );
  });

  it('rejects a query marker, which would fold the resource path into the query string', () => {
    expect(() => buildQueryUrl({ entitySet: 'Parts', baseUrl: 'https://host/svc?x=1' })).toThrow(
      /Invalid baseUrl/,
    );
  });

  it('rejects tabs and newlines, which new URL() silently strips instead of refusing', () => {
    expect(() => buildQueryUrl({ entitySet: 'Parts', baseUrl: 'https://host/a\tb' })).toThrow(
      /Invalid baseUrl/,
    );
    expect(() => buildQueryUrl({ entitySet: 'Parts', baseUrl: 'https://host/a\nb' })).toThrow(
      /Invalid baseUrl/,
    );
    expect(() => buildQueryUrl({ entitySet: 'Parts', baseUrl: 'https://host/a\rb' })).toThrow(
      /Invalid baseUrl/,
    );
  });

  it('rejects a backslash, which new URL() silently rewrites to a slash', () => {
    expect(() => buildQueryUrl({ entitySet: 'Parts', baseUrl: 'https://host/svc\\parts' })).toThrow(
      /Invalid baseUrl/,
    );
  });

  it('rejects a string that is not an absolute URL', () => {
    expect(() => buildQueryUrl({ entitySet: 'Parts', baseUrl: 'host/svc' })).toThrow(
      /Invalid baseUrl/,
    );
  });

  it('accepts a percent-encoded space and still strips trailing slashes', () => {
    expect(buildQueryUrl({ entitySet: 'Parts', baseUrl: 'https://host/a%20b/' })).toBe(
      'https://host/a%20b/Parts',
    );
  });

  it('accepts a service root with no path at all', () => {
    expect(buildQueryUrl({ entitySet: 'Parts', baseUrl: 'https://host' })).toBe(
      'https://host/Parts',
    );
  });
});

/**
 * `{` and `}` are curl glob syntax, not merely illegal characters: `a{b,c}d`
 * expands into **two** requests, so a brace in a service root silently fans out
 * to two resources — the same class of silent misrouting as `#`. A template
 * placeholder like `{tenant}` is plausible input from a model.
 *
 * `\p{Cs}` catches a lone surrogate, which no URL can represent, and a scheme
 * other than http(s) produces a URL nothing can fetch.
 */
describe('curl glob syntax, lone surrogates and foreign schemes are rejected', () => {
  it.each([
    ['https://host/svc/{tenant}', 'unmatched brace'],
    ['https://host/a{b,c}d', 'curl expands this into two requests'],
    ['https://host/a[b]', 'bad range'],
    ['https://host/a\u0001b', 'a C0 control that \\s does not cover'],
    ['https://host/a\uD800b', 'a lone surrogate'],
    ['javascript:alert(1)', 'a scheme nothing can fetch'],
    ['file:///etc/passwd', 'a local file URL'],
  ])('rejects %s — %s', (baseUrl) => {
    expect(() => buildQueryUrl({ entitySet: 'Parts', baseUrl })).toThrow(/Invalid baseUrl/);
  });

  it('still accepts an http or https service root', () => {
    expect(buildQueryUrl({ entitySet: 'Parts', baseUrl: 'https://host/svc/' })).toBe(
      'https://host/svc/Parts',
    );
  });
});

/**
 * `\p{Cf}` (zero-width and bidi controls) is not rejected by `\s`, and curl and
 * WHATWG rewrite it rather than refusing — so it round-trips rather than
 * misroutes. It is rejected anyway: a bidi override inside emitted URL text is a
 * display-spoofing hazard, and "used exactly as written or refused" is the
 * contract this validator states.
 */
describe('zero-width and bidi controls are rejected', () => {
  it.each([
    ['https://host/a\u200Bb', 'zero-width space'],
    ['https://host/a\u202Eb', 'right-to-left override'],
    ['https://host/a\u00ADb', 'soft hyphen'],
  ])('rejects %s — %s', (baseUrl) => {
    expect(() => buildQueryUrl({ entitySet: 'Parts', baseUrl })).toThrow(/Invalid baseUrl/);
  });
});
