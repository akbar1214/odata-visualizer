/**
 * Percent-encoding shared by the query builder and the MCP tool output.
 *
 * A rendered OData value is concatenated into a URL rather than sent as a
 * parameter, so anything outside the grammar of its component has to be encoded
 * or the URL is malformed. Two things make that easy to get wrong:
 *
 * - `encodeURIComponent` is the wrong tool. It leaves `!'()*` raw (fine) but
 *   throws `URIError` on a lone surrogate, which `for...of` yields as its own
 *   code point, and the error surfaces as "URI malformed" with no hint of which
 *   value caused it.
 * - The unsafe set differs per component. `/` and `?` are legal in a query
 *   string and illegal in a path segment; `[` and `]` are illegal in both and
 *   are also curl glob delimiters.
 *
 * So the caller supplies its own `unsafe` set and this handles the mechanical
 * part: non-ASCII, C0 controls, and lone surrogates. `DEL` needs no clause of
 * its own — `0x7F > 0x7E`, so the non-ASCII branch already encodes it, and a
 * separate clause would be unreachable code no test could distinguish.
 */
export function percentEncode(value: string, unsafe: ReadonlySet<string>): string {
  let encoded = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code > 0x7e) {
      if (code >= 0xd800 && code <= 0xdfff) {
        throw new Error('Value contains an unpaired surrogate and cannot be encoded for a URL.');
      }
      encoded += encodeURIComponent(char);
    } else if (code < 0x20 || unsafe.has(char)) {
      encoded += `%${code.toString(16).toUpperCase().padStart(2, '0')}`;
    } else {
      encoded += char;
    }
  }
  return encoded;
}

/**
 * Characters that cannot appear raw in a URL path segment (RFC 3986 §3.3:
 * `pchar` is unreserved, pct-encoded, sub-delims, `:` and `@` — it excludes
 * `/`) and would corrupt the request rather than travel as data.
 *
 * Encoding is deliberately narrow. `'`, `:`, `(`, `)`, `,` and `=` are all
 * legal in a path, and leaving them readable keeps OData structure legible
 * (`Parts('OR:wt.part:1')/NS.Action`) — which matters because the caller copies
 * this URL by hand. A raw space, `#` or `/`, by contrast, changes where the
 * request goes: `curl` rejects the first outright (`URL rejected: Malformed
 * input to a URL function`), `#` silently truncates the URL at a fragment
 * boundary, and `/` splits the value across extra path segments so a different
 * resource is addressed.
 *
 * `/` becomes `%2F`. Most OData servers decode that back correctly; Tomcat
 * rejects encoded slashes by default (`encodedSolidusHandling`), so a value
 * containing a slash may have to be sent as a key rather than an inline
 * parameter.
 *
 * Values are treated as raw data, never as pre-encoded URL text: a literal `%`
 * becomes `%25`. Accepting a caller's `%2F` would otherwise smuggle a path
 * separator through.
 *
 * `+` and `;` are RFC-legal raw in a path and curl accepts both, but their
 * meaning is not stable across stacks: `;` is a path-parameter delimiter to
 * servlet containers (`/Parts;jsessionid=…`) and some legacy decoders read `+`
 * as a space outside the query string. Path values are data, so both are
 * encoded. The query side keeps `;` raw because a nested `$expand` uses it as a
 * separator — there it is structure, not data.
 *
 * The set is exported so callers can compose a stricter policy
 * (`new Set([...PATH_UNSAFE, '&'])`), so it is typed `ReadonlySet` and frozen:
 * a mutation would silently change every encoder in the package, and the
 * compiler is what stops one.
 */
export const PATH_UNSAFE: ReadonlySet<string> = Object.freeze(
  new Set([
    ' ',
    '"',
    '<',
    '>',
    '\\',
    '^',
    '`',
    '{',
    '|',
    '}',
    '?',
    '#',
    '[',
    ']',
    '%',
    '/',
    // `+` and `;` are encoded in values this layer *renders*. Caller-supplied key
    // predicates are used verbatim — both are legal in an OData string literal
    // (`other-delims`), so the stack hazards are the caller's to handle and
    // `%2B`/`%3B` stay available. The rule is not global — see `query.ts`.
    '+',
    ';',
  ]),
);

/**
 * Percent-encode a rendered OData literal for use inside a URL path segment.
 *
 * The default set is the path policy. A caller can pass a stricter set: the
 * function-import selector adds `&`, whose raw form would split the copied
 * fragment whenever a client reads it as a query string. MCP emits the whole
 * URL and keeps the default.
 */
export function encodeLiteralForUrl(
  literal: string,
  unsafe: ReadonlySet<string> = PATH_UNSAFE,
): string {
  return percentEncode(literal, unsafe);
}

/**
 * Characters that are structural in the positions an identifier occupies, on
 * top of the path-unsafe set.
 *
 * Metadata names are emitted where OData syntax also uses `(` and `)` (key
 * predicates and inline parameter lists), `,` and `=` (compound keys, parameter
 * lists) and `'` (string literals). A name containing one of those is invalid
 * CSDL, but the parser accepts it on purpose, and emitting it raw would
 * silently address a different resource. Encoding keeps the name inside one
 * segment and unambiguous; the server percent-decodes before matching, so a
 * lenient server spelling a set `Th#ings` still answers to `Th%23ings`.
 *
 * Exported so a caller can compose a stricter policy: the function-import
 * selector adds `&` to keep a copied fragment from splitting when a client
 * reads it as a query string.
 */
export const IDENTIFIER_UNSAFE: ReadonlySet<string> = Object.freeze(
  new Set([...PATH_UNSAFE, '(', ')', ',', '=', "'"]),
);

/**
 * Percent-encode a metadata-derived identifier for its position in a URL.
 *
 * The default is `IDENTIFIER_UNSAFE`; a caller can pass a stricter set. MCP
 * emits whole URLs and keeps the default, because `&` is legal raw in a path
 * and the default already encodes `#`.
 */
export function encodeIdentifierForUrl(
  identifier: string,
  unsafe: ReadonlySet<string> = IDENTIFIER_UNSAFE,
): string {
  return percentEncode(identifier, unsafe);
}
