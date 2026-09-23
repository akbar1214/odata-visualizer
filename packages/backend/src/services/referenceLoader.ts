import { validateMetadataUrl } from './urlPolicy.js';

/**
 * Build a loader for `edmx:Reference/@Uri` values that resolves them over
 * HTTP relative to `baseUrl`, subject to the same allowlist/private-address
 * policy as /api/parse/url. Used when the main document is uploaded from the
 * browser but its references live next to the service.
 */
export function createHttpReferenceLoader() {
  const allowlist = parseAllowlist(process.env['METADATA_URL_ALLOWLIST']);
  const blockPrivate = process.env['METADATA_URL_BLOCK_PRIVATE'] !== '0';

  return async (uri: string): Promise<string> => {
    const target = validateMetadataUrl(uri, allowlist, { blockPrivate });
    const response = await fetch(target.toString(), {
      headers: { Accept: 'application/xml, text/xml' },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return response.text();
  };
}

function parseAllowlist(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const hosts = raw
    .split(',')
    .map((host) => host.trim())
    .filter((host) => host.length > 0);
  return hosts.length > 0 ? hosts : undefined;
}
