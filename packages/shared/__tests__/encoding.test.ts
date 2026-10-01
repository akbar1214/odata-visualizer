import { describe, it, expect } from 'vitest';
import {
  IDENTIFIER_UNSAFE,
  PATH_UNSAFE,
  encodeIdentifierForUrl,
  encodeLiteralForUrl,
  percentEncode,
} from '../src/encoding.js';

/**
 * The encoders moved into `shared` during #72, but their coverage stayed
 * indirect: the MCP suite and the function-import selector exercised them
 * end-to-end, so nothing pinned a policy at the module itself. These tests live
 * next to the code they describe.
 *
 * The policies are deliberately different per position, and the difference is
 * the point:
 *
 * - `PATH_UNSAFE` is the default for values and leaves `&` raw, because it is
 *   legal inside a path segment and MCP emits whole URLs.
 * - `IDENTIFIER_UNSAFE` adds the OData-structure characters to the path set.
 * - A caller can compose a stricter set (the selector adds `&` for both).
 */
describe('percentEncode', () => {
  it('encodes characters in the supplied unsafe set', () => {
    expect(percentEncode('a b&c', new Set([' ', '&']))).toBe('a%20b%26c');
  });

  it('encodes control characters and DEL regardless of the set', () => {
    // DEL is invisible in a terminal but outside `pchar`.
    expect(percentEncode('a\u0000b\u0009c\u007Fd', new Set())).toBe('a%00b%09c%7Fd');
  });

  it('encodes non-ASCII as UTF-8 percent-escapes', () => {
    expect(percentEncode('café', new Set())).toBe('caf%C3%A9');
  });

  it('leaves safe characters untouched', () => {
    expect(percentEncode("O'Brien:/?=,()", new Set())).toBe("O'Brien:/?=,()");
  });

  it('refuses a lone surrogate instead of throwing a bare URIError', () => {
    expect(() => percentEncode('\uD800', new Set())).toThrow(/unpaired surrogate/);
  });
});

describe('encodeLiteralForUrl', () => {
  it('applies the path policy by default', () => {
    expect(encodeLiteralForUrl('a/b c')).toBe('a%2Fb%20c');
    expect(encodeLiteralForUrl('a%b#c')).toBe('a%25b%23c');
    expect(encodeLiteralForUrl('a+b;c')).toBe('a%2Bb%3Bc');
  });

  it('keeps characters that are legal raw in a path', () => {
    expect(encodeLiteralForUrl("'O''Brien'")).toBe("'O''Brien'");
    expect(encodeLiteralForUrl('NS.Name(1)')).toBe('NS.Name(1)');
  });

  it('leaves & raw by default, because it is path-legal', () => {
    // MCP emits the whole URL, so this is the intended behaviour, not a hole.
    expect(encodeLiteralForUrl('A&B')).toBe('A&B');
  });

  it('encodes & when the caller supplies the selector policy', () => {
    expect(encodeLiteralForUrl('A&B', new Set([...PATH_UNSAFE, '&']))).toBe('A%26B');
  });
});

describe('encodeIdentifierForUrl', () => {
  it('encodes the OData-structure characters on top of the path policy', () => {
    expect(encodeIdentifierForUrl("P',=1")).toBe('P%27%2C%3D1');
    expect(encodeIdentifierForUrl('Do(It)')).toBe('Do%28It%29');
    expect(encodeIdentifierForUrl('Th#ings')).toBe('Th%23ings');
  });

  it('adds & when a caller composes the selector policy', () => {
    expect(encodeIdentifierForUrl('A&B')).toBe('A&B');
    expect(encodeIdentifierForUrl('A&B', new Set([...IDENTIFIER_UNSAFE, '&']))).toBe('A%26B');
  });
});

describe('the exported policies are immutable', () => {
  it('freezes PATH_UNSAFE and IDENTIFIER_UNSAFE', () => {
    // The types stop a TypeScript consumer from calling `.add`; freezing stops
    // the properties being replaced at runtime.
    expect(Object.isFrozen(PATH_UNSAFE)).toBe(true);
    expect(Object.isFrozen(IDENTIFIER_UNSAFE)).toBe(true);
  });
});
