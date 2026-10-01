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
 * part: non-ASCII, controls, `DEL`, and lone surrogates.
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
    } else if (code < 0x20 || code === 0x7f || unsafe.has(char)) {
      encoded += `%${code.toString(16).toUpperCase().padStart(2, '0')}`;
    } else {
      encoded += char;
    }
  }
  return encoded;
}
