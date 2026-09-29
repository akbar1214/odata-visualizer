/**
 * Policy for the `/api/parse/url` endpoint. Fetching a caller-supplied URL is
 * an SSRF vector, so schemes are always restricted and hosts can be pinned.
 */
import { lookup } from 'node:dns/promises';
// Default import, not a namespace import: ipaddr.js is CommonJS, and Node's
// native ESM loader cannot see its named exports. A namespace import type-checks
// and works under Vitest's interop, yet `ipaddr.parse` is `undefined` under
// `node dist/index.js` — which silently disabled this entire guard.
import ipaddr from 'ipaddr.js';

/** Resolves a hostname to the addresses a fetch would connect to. */
export type HostnameResolver = (hostname: string) => Promise<string[]>;

export interface UrlPolicyOptions {
  /** Reject loopback / private / link-local addresses. */
  blockPrivate?: boolean;
  /** Injectable resolver; defaults to `dns.lookup`. */
  resolveHostname?: HostnameResolver;
}

/** Thrown when a URL is refused by policy (caller error, reported as 400). */
export class UrlPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UrlPolicyError';
  }
}

const PRIVATE_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
]);

/**
 * The deprecated IPv4-compatible range `::/96` (`::x.y.z.w`). ipaddr reports it
 * as plain unicast, but it reaches the same IPv4 host as `::ffff:x.y.z.w` on any
 * stack that still honours it, so it must be refused explicitly.
 */
function isIpv4Compatible(v6: ipaddr.IPv6): boolean {
  return v6
    .toByteArray()
    .slice(0, 12)
    .every((byte) => byte === 0);
}

/**
 * Classify a bare IP literal. Only globally routable unicast addresses are
 * considered public.
 *
 * This has to parse the address rather than pattern-match its text: `new URL()`
 * normalizes every IPv4-mapped IPv6 address to hex (`::ffff:127.0.0.1` becomes
 * `[::ffff:7f00:1]`), so a dotted-form regex never matches and the entire
 * IPv4-mapped range used to bypass the guard and reach `169.254.169.254`.
 */
function isPrivateLiteral(host: string): boolean {
  let address: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    address = ipaddr.parse(host);
  } catch {
    return false; // not an address literal; hostname handling applies
  }

  if (address.kind() === 'ipv6') {
    const v6 = address as ipaddr.IPv6;
    const range = v6.range();

    // An IPv4-mapped address reaches the embedded IPv4 host, so classify it as
    // that address. AAAA records may legitimately carry this form.
    if (range === 'ipv4Mapped') {
      return isPrivateLiteral(v6.toIPv4Address().toString());
    }

    // NAT64 (64:ff9b::/96), 6to4 (2002::/16) and Teredo (2001::/32) also
    // embed a reachable IPv4 address, but the embedding is prefix-length
    // dependent. Refuse the whole range rather than risk missing a private
    // target; none of these are needed to reach an OData metadata document.
    if (range === 'rfc6052' || range === '6to4' || range === 'teredo') {
      return true;
    }

    if (isIpv4Compatible(v6)) {
      return true;
    }

    // Everything else must be globally routable unicast: this refuses loopback,
    // unspecified, link-local, unique-local, multicast and reserved space.
    return range !== 'unicast';
  }

  // 'unicast' covers RFC1918-free public space; every other range name
  // (private, loopback, linkLocal, carrierGradeNat, benchmarking, reserved,
  // multicast, unspecified, broadcast) is refused.
  return address.range() !== 'unicast';
}

function isPrivateAddress(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (PRIVATE_HOSTNAMES.has(host)) return true;
  if (host.endsWith('.localhost') || host.endsWith('.local')) return true;
  return isPrivateLiteral(host);
}

function hostAllowed(hostname: string, allowlist: string[]): boolean {
  const host = hostname.toLowerCase();
  return allowlist.some((entry) => {
    const allowed = entry.toLowerCase();
    if (allowed.startsWith('*.')) {
      const suffix = allowed.slice(1); // ".example.com"
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === allowed;
  });
}

/**
 * Validate a metadata URL, throwing an Error with a user-facing message when
 * the URL must not be fetched.
 */
export function validateMetadataUrl(
  url: string,
  allowlist?: string[],
  options: UrlPolicyOptions = {},
): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UrlPolicyError('Invalid URL format');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UrlPolicyError(
      `Unsupported URL scheme "${parsed.protocol.replace(':', '')}" (use http or https)`,
    );
  }

  if (options.blockPrivate && isPrivateAddress(parsed.hostname) && !isAllowlisted(parsed, allowlist)) {
    throw new UrlPolicyError(
      `Refusing to fetch a private or loopback address (${parsed.hostname}); set METADATA_URL_BLOCK_PRIVATE=0 to allow`,
    );
  }

  if (allowlist && allowlist.length > 0 && !isAllowlisted(parsed, allowlist)) {
    throw new UrlPolicyError(
      `Host "${parsed.hostname}" is not allowed. Set METADATA_URL_ALLOWLIST to permit it.`,
    );
  }

  return parsed;
}

/**
 * An explicitly allowlisted host is trusted by the operator. Without this,
 * `METADATA_URL_ALLOWLIST=windchill.corp.example.com` could not reach the
 * internal service it exists to permit.
 */
function isAllowlisted(parsed: URL, allowlist: string[] | undefined): boolean {
  return Boolean(allowlist && allowlist.length > 0 && hostAllowed(parsed.hostname, allowlist));
}

const DEFAULT_DNS_TIMEOUT_MS = 5000;

/** Reject `promise` if it has not settled within `ms`. */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function defaultResolveHostname(hostname: string): Promise<string[]> {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => answer.address);
}

/**
 * Reject a hostname whose DNS answers point somewhere private.
 *
 * A string check on `hostname` only covers literal addresses. Names such as
 * `localtest.me` or `127.0.0.1.nip.io` resolve to loopback, which otherwise
 * makes the whole private-address guard decorative. Every answer is checked:
 * split-horizon DNS must not pass by returning one public address first.
 */
export async function assertHostResolvesPublic(
  url: URL,
  resolveHostname: HostnameResolver = defaultResolveHostname,
  timeoutMs: number = DEFAULT_DNS_TIMEOUT_MS,
): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  // Literal addresses were already classified synchronously.
  if (ipaddr.isValid(host)) return;

  let addresses: string[];
  try {
    // getaddrinfo is not covered by the fetch's AbortSignal and occupies a
    // libuv threadpool slot, so it needs its own bound.
    addresses = await withTimeout(
      resolveHostname(host),
      timeoutMs,
      `DNS lookup timed out after ${timeoutMs}ms`,
    );
  } catch (error) {
    // Fail closed. If an unresolvable host were treated as public, an attacker
    // controlling the zone only has to answer this one query with SERVFAIL and
    // let the fetch's own lookup succeed with a private answer.
    throw new UrlPolicyError(
      `Refusing to fetch "${host}": its addresses could not be verified (${
        error instanceof Error ? error.message : 'resolution failed'
      }).`,
    );
  }

  const offending = addresses.find((address) => isPrivateLiteral(address));
  if (offending) {
    throw new UrlPolicyError(
      `Refusing to fetch "${host}": it resolves to the private or loopback address ${offending}.`,
    );
  }
}

/**
 * Validate a metadata URL *and* the addresses its host resolves to. This is the
 * entry point fetchers should use: `validateMetadataUrl` alone only inspects the
 * literal address in the URL.
 *
 * Known limitation: the address vetted here is not the one `fetch` connects to,
 * which resolves the name again. An attacker with a rebinding resolver can
 * therefore still slip past between this check and the connection. Closing that
 * window needs the connection pinned to the vetted address (an undici Agent with
 * a custom lookup), which Node does not expose on the global fetch. Deployments
 * that need it should set METADATA_URL_ALLOWLIST.
 */
export async function resolveMetadataUrl(
  url: string,
  allowlist?: string[],
  options: UrlPolicyOptions = {},
): Promise<URL> {
  const parsed = validateMetadataUrl(url, allowlist, options);
  if ((options.blockPrivate ?? true) && !isAllowlisted(parsed, allowlist)) {
    await assertHostResolvesPublic(parsed, options.resolveHostname);
  }
  return parsed;
}
