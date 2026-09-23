/**
 * Policy for the `/api/parse/url` endpoint. Fetching a caller-supplied URL is
 * an SSRF vector, so schemes are always restricted and hosts can be pinned.
 */

export interface UrlPolicyOptions {
  /** Reject loopback / private / link-local addresses. */
  blockPrivate?: boolean;
}

const PRIVATE_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
]);

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => Number(p));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  return false;
}

function isPrivateAddress(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (PRIVATE_HOSTNAMES.has(host)) return true;
  if (host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return isPrivateIpv4(host);
  if (host === '::1' || host === '::') return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true; // unique local
  if (/^fe80:/i.test(host)) return true; // link-local
  // IPv4-mapped IPv6, e.g. ::ffff:127.0.0.1
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(host);
  if (mapped) return isPrivateIpv4(mapped[1]);
  return false;
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
    throw new Error('Invalid URL format');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Unsupported URL scheme "${parsed.protocol.replace(':', '')}" (use http or https)`,
    );
  }

  if (options.blockPrivate && isPrivateAddress(parsed.hostname)) {
    throw new Error(
      `Refusing to fetch a private or loopback address (${parsed.hostname}); set METADATA_URL_BLOCK_PRIVATE=0 to allow`,
    );
  }

  if (allowlist && allowlist.length > 0 && !hostAllowed(parsed.hostname, allowlist)) {
    throw new Error(
      `Host "${parsed.hostname}" is not allowed. Set METADATA_URL_ALLOWLIST to permit it.`,
    );
  }

  return parsed;
}
