import { readFile } from 'node:fs/promises';
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
 * Parse a CSDL document from disk. Relative `edmx:Reference/@Uri` values
 * resolve against the document's own location (and may not escape it), so
 * multi-file models load as one model.
 */
export async function parseCSDLFile(path: string): Promise<ODataMetadata> {
  const absolutePath = isAbsolute(path) ? path : resolvePath(path);
  const baseDirectory = dirname(absolutePath);
  const xmlContent = await readFile(absolutePath, 'utf-8');
  return parseCSDL(xmlContent, {
    baseUri: `file://${absolutePath}`,
    loadExternal: async (uri) => readFile(resolveSiblingPath(uri, baseDirectory), 'utf-8'),
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
