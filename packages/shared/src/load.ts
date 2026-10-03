import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve as resolvePath, sep } from 'node:path';
import { parseCSDL } from './parser.js';
import type { ODataMetadata } from './types.js';

const DEFAULT_TIMEOUT_MS = 30000;

/** Mirrors the backend's fetch policy: a longer redirect chain is refused. */
const MAX_REDIRECTS = 5;

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
 * `Headers` accepts this name and reports it back, but undici's wire
 * serialization never sends it, so accepting it would be a silent drop. Every
 * other `Object.prototype` name (`constructor`, `toString`, ...) does transmit.
 */
const DROPPED_FETCH_HEADER = '__proto__';

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
 * True when a value carries a character fetch cannot carry: a C0 control
 * except HTAB, DEL, or anything above U+00FF (`Headers.set` needs a
 * ByteString). Without this the fetch throws and the route reports what is
 * really a caller error as a 500.
 */
function hasInvalidHeaderValueCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code !== 0x09 && (code <= 0x1f || code === 0x7f || code > 0xff)) return true;
  }
  return false;
}

/**
 * Validate caller-supplied request headers and return a normalized copy
 * (names lower-cased; the caller's object is left untouched).
 *
 * Header values are credentials, so they must never reach an error message or
 * a log; a rejected value is reported by its header's name instead. Rejecting
 * CR, LF and the other controls keeps a value from splitting one request into
 * two, and refuses what fetch itself would reject.
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

  const normalized: Array<[string, string]> = [];
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
    if (hasInvalidHeaderValueCharacter(value)) {
      throw new Error(`Header ${JSON.stringify(name)} has an invalid character in its value`);
    }

    const lower = name.toLowerCase();
    if (seen.has(lower)) {
      throw new Error(`Duplicate header ${JSON.stringify(name)}`);
    }
    if (DENIED_FETCH_HEADERS.has(lower)) {
      throw new Error(`Header ${JSON.stringify(name)} is not allowed`);
    }
    // The MCP SDK's `z.record` drops this name before the handler runs, so on
    // that path it never reaches here; the REST route does.
    if (lower === DROPPED_FETCH_HEADER) {
      throw new Error(
        `Header ${JSON.stringify(DROPPED_FETCH_HEADER)} cannot be sent by the fetch runtime and would be dropped silently`,
      );
    }

    totalBytes += Buffer.byteLength(name, 'utf8') + Buffer.byteLength(value, 'utf8');
    if (totalBytes > MAX_HEADER_TOTAL_BYTES) {
      throw new Error(`Headers are larger than the ${MAX_HEADER_TOTAL_BYTES}-byte limit`);
    }

    seen.add(lower);
    normalized.push([lower, value]);
  }

  // `fromEntries` defines own data properties, so a header name that shadows
  // `Object.prototype` (`constructor`, `toString`, ...) is kept instead of
  // reaching the prototype setter and vanishing.
  return Object.fromEntries(normalized);
}

/** Build the request headers for one fetch: `Accept` first, extras may override it. */
function httpHeaders(accept: string | undefined, extra?: Record<string, string>): Headers {
  const headers = new Headers({ accept: accept ?? 'application/xml, text/xml' });
  for (const [name, value] of Object.entries(extra ?? {})) headers.set(name, value);
  return headers;
}

/**
 * Fetch a document, following redirects manually so credentials are sent only
 * to a hop on the root document's origin.
 *
 * Letting fetch follow redirects is not enough: it strips `Authorization` and
 * `Cookie`, but a custom credential such as `X-Api-Key` would be delivered to
 * whatever origin the redirect names.
 */
async function fetchFollowingRedirects(
  url: string,
  accept: string | undefined,
  credentials: Record<string, string> | undefined,
  rootOrigin: string | undefined,
  timeoutMs: number,
): Promise<Response> {
  // One deadline for the whole chain, mirroring the backend's fetch policy.
  const signal = AbortSignal.timeout(timeoutMs);
  let current = new URL(url);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetch(current.toString(), {
      headers: httpHeaders(
        accept,
        credentials && current.origin === rootOrigin ? credentials : undefined,
      ),
      redirect: 'manual',
      signal,
    });

    const location = response.headers.get('location');
    const isRedirect = response.status >= 300 && response.status < 400 && location;
    if (!isRedirect) return response;

    // Release the hop's socket before opening the next one; an undrained body
    // keeps the connection out of the reuse pool.
    await response.body?.cancel().catch(() => undefined);
    current = new URL(location, current);
  }

  throw new Error(`Too many redirects (more than ${MAX_REDIRECTS})`);
}

/**
 * Parse a CSDL document from a URL. Relative `edmx:Reference/@Uri` values
 * resolve against the document URL.
 *
 * `headers` are credentials for the metadata server: they are validated up
 * front, sent on the root fetch, and — for the default `loadExternal` — sent to
 * a reference only when it is same-origin with the root document. Redirects are
 * followed manually, so a hop (of the root fetch or of a reference) on another
 * origin never receives them either.
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
  // `!== undefined`, not truthiness: `null`, `''`, `0` and `false` are
  // non-objects and must reach the validator rather than skip it and fetch
  // unauthenticated.
  const headers = options.headers !== undefined ? validateFetchHeaders(options.headers) : undefined;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // The root document's origin anchors which hops and references may carry the
  // credentials, even after the root fetch itself has been redirected.
  const rootOrigin = new URL(url).origin;

  const response = await fetchFollowingRedirects(
    url,
    options.accept,
    headers,
    rootOrigin,
    timeoutMs,
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch metadata: HTTP ${response.status} ${response.statusText}`);
  }

  const xmlContent = await response.text();
  return parseCSDL(xmlContent, {
    baseUri: url,
    loadExternal:
      options.loadExternal ??
      (async (uri) => {
        const external = await fetchFollowingRedirects(
          uri,
          options.accept,
          headers,
          rootOrigin,
          timeoutMs,
        );
        if (!external.ok) {
          throw new Error(`HTTP ${external.status} ${external.statusText}`);
        }
        return external.text();
      }),
  });
}
