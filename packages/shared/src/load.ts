import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve as resolvePath, sep } from 'node:path';
import { parseCSDL } from './parser.js';
import type { ODataMetadata } from './types.js';

const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Resolve an `edmx:Reference/@Uri` to a path and refuse anything that escapes
 * the document's directory. A metadata file must not be able to read
 * arbitrary files on the host. The parser resolves references against the
 * document's base URI before calling the loader, so the value here is absolute.
 */
function resolveSiblingPath(uri: string, baseDirectory: string): string {
  const candidate = uri.startsWith('file://')
    ? decodeURIComponent(uri.replace(/^file:\/\/(localhost)?/, ''))
    : resolvePath(baseDirectory, uri);

  const resolved = resolvePath(candidate);
  const rel = relative(baseDirectory, resolved);
  if (rel.startsWith('..') || isAbsolute(rel) || !resolved.startsWith(baseDirectory + sep)) {
    throw new Error(`Reference "${uri}" is outside the document directory`);
  }
  return resolved;
}

/**
 * Read exactly `size` bytes from an open handle. A whole-handle `readFile`
 * would pick up bytes appended after the size was checked, so the read is
 * bounded by construction.
 */
export async function readExactly(handle: FileHandle, size: number): Promise<string> {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.toString('utf-8', 0, offset);
}

/**
 * Read a regular file without blocking on a FIFO or racing a size change: the
 * file is opened once with `O_NONBLOCK`, fstat'ed, and exactly the fstat'ed
 * number of bytes are read from that handle. Non-regular files and files over
 * `maxBytes` are rejected before any content is read. `byteLength` is that raw
 * fstat size — never a re-encode of the decoded string, which can grow when
 * the file contains invalid UTF-8.
 */
export async function readRegularFile(
  path: string,
  maxBytes?: number,
): Promise<{ content: string; byteLength: number }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error(`"${path}" is not a regular file`);
    }
    if (maxBytes !== undefined && stats.size > maxBytes) {
      throw new Error(`"${path}" is ${stats.size} bytes, which exceeds the ${maxBytes}-byte limit`);
    }
    return { content: await readExactly(handle, stats.size), byteLength: stats.size };
  } finally {
    await handle.close();
  }
}

/**
 * Parse a CSDL document from disk. Relative `edmx:Reference/@Uri` values
 * resolve against the document's own location (and may not escape it), so
 * multi-file models load as one model.
 *
 * When `xmlContent` is supplied it is parsed instead of re-reading the file —
 * callers that already hold the bytes (and validated their size) avoid a second
 * read. `path` still anchors relative references.
 */
export async function parseCSDLFile(path: string, xmlContent?: string): Promise<ODataMetadata> {
  const absolutePath = isAbsolute(path) ? path : resolvePath(path);
  const baseDirectory = dirname(absolutePath);
  const content = xmlContent ?? (await readRegularFile(absolutePath)).content;
  return parseCSDL(content, {
    baseUri: `file://${absolutePath}`,
    loadExternal: async (uri) =>
      (await readRegularFile(resolveSiblingPath(uri, baseDirectory))).content,
  });
}

/** Caps sized for a bearer token plus a few extra headers, not for bulk data. */
const MAX_FETCH_HEADERS = 20;
const MAX_HEADER_NAME_LENGTH = 64;
const MAX_HEADER_VALUE_LENGTH = 4096;
const MAX_HEADER_TOTAL_BYTES = 16 * 1024;

/** RFC 7230 `token`: the only characters a header name may contain. */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Headers that control framing or the connection itself. A caller-supplied
 * `host` or `content-length` would let a request smuggle a second message or
 * address a proxy hop directly, and none of them can carry credentials.
 */
const DENIED_FETCH_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'upgrade',
  'expect',
  'te',
  'trailer',
  'keep-alive',
  'proxy-connection',
]);

/**
 * Validate caller-supplied request headers and return a normalized copy
 * (names lower-cased; the caller's object is left untouched).
 *
 * Header values are credentials, so they must never reach an error message or
 * a log; a rejected value is reported by its header's name instead. Rejecting
 * CR, LF and NUL keeps a value from splitting one request into two.
 */
export function validateFetchHeaders(headers: Record<string, string>): Record<string, string> {
  const candidate: unknown = headers;
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('Headers must be an object of string values');
  }

  const entries = Object.entries(headers) as Array<[string, unknown]>;
  if (entries.length > MAX_FETCH_HEADERS) {
    throw new Error(
      `Too many headers (${entries.length}); at most ${MAX_FETCH_HEADERS} are allowed`,
    );
  }

  const normalized: Record<string, string> = {};
  const seen = new Set<string>();
  let totalBytes = 0;

  for (const [name, value] of entries) {
    if (name.length > MAX_HEADER_NAME_LENGTH) {
      throw new Error(
        `Header name ${JSON.stringify(name)} is longer than ${MAX_HEADER_NAME_LENGTH} characters`,
      );
    }
    if (!HEADER_NAME_PATTERN.test(name)) {
      throw new Error(`Header name ${JSON.stringify(name)} is not a valid HTTP header name`);
    }
    if (typeof value !== 'string') {
      throw new Error(`Header ${JSON.stringify(name)} must have a string value`);
    }
    if (value.length > MAX_HEADER_VALUE_LENGTH) {
      throw new Error(
        `Header ${JSON.stringify(name)} has a value longer than ${MAX_HEADER_VALUE_LENGTH} characters`,
      );
    }
    if (value.includes('\r') || value.includes('\n') || value.includes('\0')) {
      throw new Error(`Header ${JSON.stringify(name)} has an invalid character in its value`);
    }

    const lower = name.toLowerCase();
    if (seen.has(lower)) {
      throw new Error(`Duplicate header ${JSON.stringify(name)}`);
    }
    if (DENIED_FETCH_HEADERS.has(lower)) {
      throw new Error(`Header ${JSON.stringify(name)} is not allowed`);
    }

    totalBytes += Buffer.byteLength(name, 'utf8') + Buffer.byteLength(value, 'utf8');
    if (totalBytes > MAX_HEADER_TOTAL_BYTES) {
      throw new Error(`Headers are larger than the ${MAX_HEADER_TOTAL_BYTES}-byte limit`);
    }

    seen.add(lower);
    normalized[lower] = value;
  }

  return normalized;
}

/** Build the request headers for one fetch: `Accept` first, extras may override it. */
function httpHeaders(accept: string | undefined, extra?: Record<string, string>): Headers {
  const headers = new Headers({ accept: accept ?? 'application/xml, text/xml' });
  for (const [name, value] of Object.entries(extra ?? {})) headers.set(name, value);
  return headers;
}

/**
 * Parse a CSDL document from a URL. Relative `edmx:Reference/@Uri` values
 * resolve against the document URL.
 *
 * `headers` are credentials for the metadata server: they are validated up
 * front, sent on the root fetch, and — for the default `loadExternal` — sent to
 * a reference only when it is same-origin with the root document. A reference
 * on another origin must not receive the root's credentials.
 *
 * Callers that run behind an SSRF policy (the backend) can pass
 * `loadExternal` to validate every reference request themselves; those callers
 * control their own headers.
 */
export async function parseCSDLUrl(
  url: string,
  options: {
    timeoutMs?: number;
    accept?: string;
    headers?: Record<string, string>;
    loadExternal?: (uri: string) => Promise<string>;
  } = {},
): Promise<ODataMetadata> {
  const headers = options.headers ? validateFetchHeaders(options.headers) : undefined;

  const response = await fetch(url, {
    headers: httpHeaders(options.accept, headers),
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch metadata: HTTP ${response.status} ${response.statusText}`);
  }

  const xmlContent = await response.text();
  // Resolved only now, so an invalid `url` fails at `fetch` exactly as before.
  const rootOrigin = headers ? new URL(url).origin : undefined;
  return parseCSDL(xmlContent, {
    baseUri: url,
    loadExternal:
      options.loadExternal ??
      (async (uri) => {
        const referenceHeaders =
          rootOrigin && new URL(uri).origin === rootOrigin ? headers : undefined;
        const external = await fetch(uri, {
          headers: httpHeaders(options.accept, referenceHeaders),
          signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
        if (!external.ok) {
          throw new Error(`HTTP ${external.status} ${external.statusText}`);
        }
        return external.text();
      }),
  });
}
