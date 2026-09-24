import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { parseCSDL } from './parser.js';
import type { ODataMetadata } from './types.js';

const DEFAULT_TIMEOUT_MS = 30000;

/** Convert a file:// URI to a filesystem path. */
function fileUriToPath(uri: string): string {
  if (!uri.startsWith('file://')) return uri;
  return decodeURIComponent(uri.replace(/^file:\/\/(localhost)?/, ''));
}

/**
 * Parse a CSDL document from disk. Relative `edmx:Reference/@Uri` values
 * resolve against the document's own location, so multi-file models load as
 * one model.
 */
export async function parseCSDLFile(path: string): Promise<ODataMetadata> {
  const absolutePath = isAbsolute(path) ? path : resolvePath(path);
  const xmlContent = await readFile(absolutePath, 'utf-8');
  return parseCSDL(xmlContent, {
    baseUri: `file://${absolutePath}`,
    loadExternal: async (uri) => readFile(fileUriToPath(uri), 'utf-8'),
  });
}

/**
 * Parse a CSDL document from a URL. Relative `edmx:Reference/@Uri` values
 * resolve against the document URL.
 */
export async function parseCSDLUrl(
  url: string,
  options: { timeoutMs?: number; accept?: string } = {},
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
    loadExternal: async (uri) => {
      const external = await fetch(uri, {
        headers: { Accept: options.accept ?? 'application/xml, text/xml' },
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!external.ok) {
        throw new Error(`HTTP ${external.status} ${external.statusText}`);
      }
      return external.text();
    },
  });
}
