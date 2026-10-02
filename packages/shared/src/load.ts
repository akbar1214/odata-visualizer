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

/**
 * Parse a CSDL document from a URL. Relative `edmx:Reference/@Uri` values
 * resolve against the document URL.
 *
 * Callers that run behind an SSRF policy (the backend) can pass
 * `loadExternal` to validate every reference request themselves.
 */
export async function parseCSDLUrl(
  url: string,
  options: {
    timeoutMs?: number;
    accept?: string;
    loadExternal?: (uri: string) => Promise<string>;
  } = {},
): Promise<ODataMetadata> {
  const response = await fetch(url, {
    headers: { Accept: options.accept ?? 'application/xml, text/xml' },
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch metadata: HTTP ${response.status} ${response.statusText}`);
  }

  const xmlContent = await response.text();
  return parseCSDL(xmlContent, {
    baseUri: url,
    loadExternal:
      options.loadExternal ??
      (async (uri) => {
        const external = await fetch(uri, {
          headers: { Accept: options.accept ?? 'application/xml, text/xml' },
          signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
        if (!external.ok) {
          throw new Error(`HTTP ${external.status} ${external.statusText}`);
        }
        return external.text();
      }),
  });
}
