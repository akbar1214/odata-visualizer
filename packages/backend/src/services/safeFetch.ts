import { validateMetadataUrl } from './urlPolicy.js';

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 30000;

/** Thrown when a redirect chain is too long (upstream problem, reported as 502). */
export class RedirectLimitError extends Error {
  constructor(limit: number) {
    super(`Too many redirects (more than ${limit})`);
    this.name = 'RedirectLimitError';
  }
}

export interface FetchPolicyOptions {
  allowlist?: string[];
  blockPrivate?: boolean;
  accept?: string;
  timeoutMs?: number;
}

function parseAllowlist(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const hosts = raw
    .split(',')
    .map((host) => host.trim())
    .filter((host) => host.length > 0);
  return hosts.length > 0 ? hosts : undefined;
}

/** The URL policy configured through the environment. */
export function urlPolicyFromEnv(): { allowlist?: string[]; blockPrivate: boolean } {
  return {
    allowlist: parseAllowlist(process.env['METADATA_URL_ALLOWLIST']),
    blockPrivate: process.env['METADATA_URL_BLOCK_PRIVATE'] !== '0',
  };
}

/**
 * Fetch a URL, validating **before every request** and following redirects
 * manually.
 *
 * Relying on fetch's automatic redirect handling is not enough: a validated
 * public URL can 302 to a private address, and the response body would already
 * have been fetched by the time we noticed. Validating each hop first means a
 * blocked hop is never requested at all.
 */
export async function fetchWithPolicy(
  url: string,
  options: FetchPolicyOptions = {},
): Promise<Response> {
  const allowlist = options.allowlist;
  const blockPrivate = options.blockPrivate ?? true;
  let current = validateMetadataUrl(url, allowlist, { blockPrivate });

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetch(current.toString(), {
      headers: { Accept: options.accept ?? 'application/xml, text/xml' },
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });

    const location = response.headers.get('location');
    const isRedirect = response.status >= 300 && response.status < 400 && location;
    if (!isRedirect) return response;

    // Validated before the next request is issued.
    current = validateMetadataUrl(new URL(location, current).toString(), allowlist, {
      blockPrivate,
    });
  }

  throw new RedirectLimitError(MAX_REDIRECTS);
}
