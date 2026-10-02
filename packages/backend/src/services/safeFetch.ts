import { resolveMetadataUrl, type HostnameResolver } from './urlPolicy.js';
import { ResponseTooLargeError } from './errors.js';

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Upper bound on a metadata document. A real `$metadata` document is a few
 * hundred KB; `response.text()` buffers the whole body before the parser ever
 * sees it, so an unbounded upstream can exhaust the heap.
 */
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

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
  /**
   * Caller-supplied request headers (validated by the caller). Sent on every
   * hop that shares the initial URL's origin; a cross-origin redirect drops
   * them, mirroring the fetch spec. `Accept` is always applied and a caller
   * header may override it.
   */
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Injectable DNS resolver; see `assertHostResolvesPublic`. */
  resolveHostname?: HostnameResolver;
  /** Refuse a response body larger than this (default 32 MB). */
  maxResponseBytes?: number;
}

/**
 * Request headers for one hop. `Accept` is applied first so a caller-supplied
 * one (in any case) overrides it rather than being combined with it.
 */
function hopHeaders(options: FetchPolicyOptions, includeCallerHeaders: boolean): Headers {
  const headers = new Headers({ accept: options.accept ?? 'application/xml, text/xml' });
  if (includeCallerHeaders) {
    for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
  }
  return headers;
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
 *
 * Validation covers the resolved addresses as well as the URL text, because a
 * public hostname can still point at loopback or the cloud metadata endpoint.
 */
export async function fetchWithPolicy(
  url: string,
  options: FetchPolicyOptions = {},
): Promise<Response> {
  const allowlist = options.allowlist;
  const blockPrivate = options.blockPrivate ?? true;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  // One deadline for the whole chain. Creating the signal per hop made the real
  // worst case (MAX_REDIRECTS + 1) x timeoutMs while callers were told the
  // timeout was a single timeoutMs.
  const signal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let current = await resolveMetadataUrl(url, allowlist, {
    blockPrivate,
    resolveHostname: options.resolveHostname,
  });
  const rootOrigin = current.origin;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetch(current.toString(), {
      headers: hopHeaders(options, current.origin === rootOrigin),
      redirect: 'manual',
      signal,
    });

    const location = response.headers.get('location');
    const isRedirect = response.status >= 300 && response.status < 400 && location;
    if (!isRedirect) {
      // Only the declared length can be checked without consuming the body,
      // which the caller still has to read.
      assertDeclaredLengthWithinLimit(response, maxBytes);
      return response;
    }

    // Release the hop's socket before opening the next one; an undrained body
    // keeps the connection out of the reuse pool.
    await response.body?.cancel().catch(() => undefined);

    // Validated before the next request is issued.
    current = await resolveMetadataUrl(new URL(location, current).toString(), allowlist, {
      blockPrivate,
      resolveHostname: options.resolveHostname,
    });
  }

  throw new RedirectLimitError(MAX_REDIRECTS);
}

/** Refuse a body whose declared Content-Length already exceeds the cap. */
function assertDeclaredLengthWithinLimit(response: Response, maxBytes: number): void {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isSafeInteger(declared) && declared > maxBytes) {
    throw new ResponseTooLargeError(
      `Metadata document is too large (${declared} bytes, limit ${maxBytes}).`,
    );
  }
}

/**
 * Read a policy-approved response body, refusing anything over the cap.
 *
 * `response.text()` buffers the whole body, so the cap has to be enforced here
 * rather than after the fact — by the time the caller sees a giant string the
 * memory has already been spent.
 */
export async function readLimitedText(response: Response, maxBytes?: number): Promise<string> {
  const limit = maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  assertDeclaredLengthWithinLimit(response, limit);

  const text = await response.text();
  const actual = Buffer.byteLength(text, 'utf8');
  if (actual > limit) {
    throw new ResponseTooLargeError(
      `Metadata document is too large (${actual} bytes, limit ${limit}).`,
    );
  }
  return text;
}
