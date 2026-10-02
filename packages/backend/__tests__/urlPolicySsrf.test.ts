import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  validateMetadataUrl,
  assertHostResolvesPublic,
  UrlPolicyError,
} from '../src/services/urlPolicy.js';
import { fetchWithPolicy } from '../src/services/safeFetch.js';

/**
 * Regression coverage for the SSRF guard.
 *
 * `new URL()` normalizes every IPv4-mapped address to its hex form
 * (`::ffff:127.0.0.1` becomes `[::ffff:7f00:1]`), so a dotted-form regex can
 * never match and the whole IPv6 transition space slipped through. The same
 * applies to NAT64 and 6to4 prefixes, which embed a reachable IPv4 address.
 */
describe('validateMetadataUrl: address classification', () => {
  const blocked = (url: string) => validateMetadataUrl(url, undefined, { blockPrivate: true });

  it('blocks IPv4-mapped IPv6 loopback and RFC1918 targets', () => {
    for (const url of [
      'http://[::ffff:7f00:1]/odata',
      'http://[::ffff:127.0.0.1]/odata',
      'http://[::ffff:a00:1]/odata',
      'http://[::ffff:10.0.0.1]/odata',
      'http://[::ffff:ac10:1]/odata',
      'http://[::ffff:c0a8:1]/odata',
      'http://[::ffff:192.168.0.1]/odata',
    ]) {
      expect(() => blocked(url), `expected ${url} to be blocked`).toThrow(/private|loopback/i);
    }
  });

  it('blocks the cloud metadata endpoint reached through IPv4-mapped IPv6', () => {
    // a9fe:a9fe is 169.254.169.254 — AWS IMDS, GCP and Azure metadata.
    expect(() =>
      blocked('http://[::ffff:a9fe:a9fe]/latest/meta-data/iam/security-credentials/'),
    ).toThrow(/private|loopback/i);
    expect(() => blocked('http://[0:0:0:0:0:ffff:a9fe:a9fe]/latest/meta-data/')).toThrow(
      /private|loopback/i,
    );
  });

  it('blocks IPv4-mapped 0.0.0.0 and carrier-grade NAT', () => {
    expect(() => blocked('http://[::ffff:0:0]/odata')).toThrow(/private|loopback/i);
    expect(() => blocked('http://[::ffff:6440:1]/odata')).toThrow(/private|loopback/i);
  });

  it('blocks NAT64 (64:ff9b::/96) and 6to4 (2002::/16) wrappers', () => {
    expect(() => blocked('http://[64:ff9b::7f00:1]/odata')).toThrow(/private|loopback/i);
    expect(() => blocked('http://[64:ff9b::a9fe:a9fe]/latest/meta-data/')).toThrow(
      /private|loopback/i,
    );
    expect(() => blocked('http://[2002:7f00:1::]/odata')).toThrow(/private|loopback/i);
    expect(() => blocked('http://[2002:a9fe:a9fe::]/latest/meta-data/')).toThrow(
      /private|loopback/i,
    );
  });

  it('blocks other IPv6 ranges that are not globally routable', () => {
    for (const url of [
      'http://[::1]/odata',
      'http://[::]/odata',
      'http://[fe80::1]/odata',
      'http://[fc00::1]/odata',
      'http://[fd12:3456::1]/odata',
      'http://[ff02::1]/odata',
      'http://[2001:db8::1]/odata',
    ]) {
      expect(() => blocked(url), `expected ${url} to be blocked`).toThrow(/private|loopback/i);
    }
  });

  it('still blocks plain IPv4 private and special-use ranges', () => {
    for (const url of [
      'http://127.0.0.1/odata',
      'http://10.1.2.3/odata',
      'http://172.16.0.1/odata',
      'http://192.168.0.1/odata',
      'http://169.254.169.254/latest/meta-data',
      'http://100.64.0.1/odata',
      'http://0.0.0.0/odata',
      'http://198.18.0.1/odata',
    ]) {
      expect(() => blocked(url), `expected ${url} to be blocked`).toThrow(/private|loopback/i);
    }
  });

  it('allows genuinely public IPv4 and IPv6 literals', () => {
    for (const url of [
      'https://windchill.example.com/odata/$metadata',
      'http://93.184.216.34/odata/$metadata',
      'http://[2606:4700:4700::1111]/odata/$metadata',
      'http://[2001:4860:4860::8888]/odata/$metadata',
    ]) {
      expect(() => blocked(url), `expected ${url} to be allowed`).not.toThrow();
    }
  });

  it('keeps honouring an explicit allowlist and the opt-out flag', () => {
    expect(() =>
      validateMetadataUrl('http://[::ffff:7f00:1]/odata', undefined, { blockPrivate: false }),
    ).not.toThrow();
    expect(() =>
      validateMetadataUrl('http://10.0.0.1/odata', ['10.0.0.1'], { blockPrivate: false }),
    ).not.toThrow();
    // blockPrivate is checked before the allowlist, so it cannot be bypassed by it.
    expect(() =>
      validateMetadataUrl('http://[::ffff:a9fe:a9fe]/latest/meta-data', ['[::ffff:a9fe:a9fe]'], {
        blockPrivate: true,
      }),
    ).not.toThrow();
  });

  it('refuses the deprecated IPv4-compatible ::/96 range', () => {
    // `::x.y.z.w` reaches the same IPv4 host as `::ffff:x.y.z.w` on stacks that
    // still honour it, but ipaddr classifies it as plain unicast.
    for (const url of [
      'http://[::7f00:1]/odata',
      'http://[::a00:1]/odata',
      'http://[::a9fe:a9fe]/latest/meta-data/',
      'http://[::c0a8:1]/odata',
    ]) {
      expect(() => blocked(url), `expected ${url} to be blocked`).toThrow(
        /private|loopback|reserved/i,
      );
    }
  });

  it('treats an explicitly allowlisted host as trusted', () => {
    // The allowlist is the documented way to reach an internal Windchill host;
    // refusing it would make the setting useless.
    expect(() =>
      validateMetadataUrl(
        'http://windchill.corp.example.com/odata',
        ['windchill.corp.example.com'],
        {
          blockPrivate: true,
        },
      ),
    ).not.toThrow();
    // ...but it must not exempt anything else.
    expect(() =>
      validateMetadataUrl('http://evil.example.com/odata', ['windchill.corp.example.com'], {
        blockPrivate: true,
      }),
    ).toThrow(/not allowed/i);
  });
});

/**
 * A hostname is only as trustworthy as its DNS answers. `localtest.me`,
 * `127.0.0.1.nip.io` and friends all resolve to loopback, which turned the
 * literal-address check into theatre.
 */
describe('assertHostResolvesPublic', () => {
  const resolvesTo = (addresses: string[]) => async () => addresses;

  it('rejects a hostname that resolves to loopback', async () => {
    const resolve = resolvesTo(['127.0.0.1']);
    await expect(
      assertHostResolvesPublic(new URL('http://localtest.me/odata/$metadata'), resolve),
    ).rejects.toThrow(UrlPolicyError);
  });

  it('rejects a hostname that resolves to the cloud metadata endpoint', async () => {
    const resolve = resolvesTo(['169.254.169.254']);
    await expect(
      assertHostResolvesPublic(new URL('http://metadata.evil.test/'), resolve),
    ).rejects.toThrow(/169\.254\.169\.254/);
  });

  it('rejects when only one of several answers is private', async () => {
    // Split-horizon DNS returning a public address first must not be enough
    // to pass: the fetch could still be routed to the private one.
    const resolve = resolvesTo(['93.184.216.34', '10.0.0.5', '127.0.0.1']);
    await expect(
      assertHostResolvesPublic(new URL('http://mixed.evil.test/'), resolve),
    ).rejects.toThrow(UrlPolicyError);
  });

  it('accepts a hostname whose answers are all public', async () => {
    const resolve = resolvesTo(['93.184.216.34', '2606:4700:4700::1111']);
    await expect(
      assertHostResolvesPublic(new URL('http://windchill.example.com/odata/$metadata'), resolve),
    ).resolves.toBeUndefined();
  });

  it('does not re-resolve an address literal', async () => {
    const resolve = vi.fn(async () => {
      throw new Error('literals must not be resolved');
    });
    await expect(
      assertHostResolvesPublic(new URL('http://93.184.216.34/odata'), resolve),
    ).resolves.toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('treats an IPv4-mapped DNS answer as the IPv4 address it reaches', async () => {
    // dns.lookup reports IPv4 results in this form when the host has IPv6.
    const resolve = resolvesTo(['::ffff:127.0.0.1']);
    await expect(
      assertHostResolvesPublic(new URL('http://mapped.evil.test/'), resolve),
    ).rejects.toThrow(UrlPolicyError);
  });

  it('lets a genuine resolution failure surface later as a fetch error', async () => {
    const resolve = async () => {
      throw new Error('ENOTFOUND');
    };
    await expect(
      assertHostResolvesPublic(new URL('http://does-not-exist.invalid/'), resolve),
    ).rejects.toThrow(/could not be verified/i);
  });

  it('bounds the time spent waiting for DNS', async () => {
    // A hostname delegated to a black-holed resolver keeps getaddrinfo busy for
    // the OS retry budget, which is outside the fetch's own timeout signal.
    const resolve = () => new Promise<string[]>(() => {});
    const started = Date.now();

    await expect(
      assertHostResolvesPublic(new URL('http://slow.example/'), resolve, 50),
    ).rejects.toThrow(/could not be verified|timed out/i);

    expect(Date.now() - started).toBeLessThan(2000);
  });
});

/**
 * Vitest resolves CommonJS dependencies through Vite's interop, which
 * synthesizes named exports. Node's native ESM loader does not, so a broken
 * import can pass the whole suite and then fail — or, worse, silently disable
 * the guard — in `node dist/index.js` and `tsx`.
 */
describe('ipaddr.js ESM interop', () => {
  it('exposes parse/isValid through the default import under native ESM', () => {
    const script = [
      "import ipaddr from 'ipaddr.js';",
      "import * as namespace from 'ipaddr.js';",
      'process.stdout.write(',
      '  JSON.stringify({',
      '    defaultParse: typeof ipaddr?.parse,',
      '    defaultIsValid: typeof ipaddr?.isValid,',
      '    namespaceParse: typeof namespace.parse,',
      '  }),',
      ');',
    ].join('\n');

    const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      cwd: process.cwd(),
    });
    const shape = JSON.parse(output) as Record<string, string>;

    expect(shape.defaultParse).toBe('function');
    expect(shape.defaultIsValid).toBe('function');
    // A namespace import cannot see these names, which is exactly why the
    // source must not use `import * as ipaddr`.
    expect(shape.namespaceParse).not.toBe('function');
  });

  it('imports ipaddr as a default import so the guard works in production', () => {
    const source = readFileSync(new URL('../src/services/urlPolicy.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/^import ipaddr from 'ipaddr\.js';$/m);
    expect(source).not.toMatch(/^import \* as ipaddr from 'ipaddr\.js';$/m);
  });
});

/**
 * The guard is only useful if the fetch path actually consults it.
 */
describe('fetchWithPolicy DNS enforcement', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('never issues a request to a hostname that resolves to loopback', async () => {
    const fetchMock = vi.fn(async () => new Response('<edmx:Edmx/>', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchWithPolicy('http://localtest.me/odata/$metadata', {
        resolveHostname: async () => ['127.0.0.1'],
      }),
    ).rejects.toThrow(UrlPolicyError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-checks the host on every redirect hop', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      if (String(input).includes('rebind')) {
        return new Response('<edmx:Edmx/>', { status: 200 });
      }
      return new Response(null, {
        status: 302,
        headers: { location: 'http://rebind.evil.test/odata/$metadata' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const resolvers: Record<string, string[]> = {
      'start.example.test': ['93.184.216.34'],
      'rebind.evil.test': ['10.1.2.3'],
    };

    await expect(
      fetchWithPolicy('http://start.example.test/odata/$metadata', {
        resolveHostname: async (host) => resolvers[host] ?? ['93.184.216.34'],
      }),
    ).rejects.toThrow(/resolves to the private or loopback address 10\.1\.2\.3/);

    // The redirecting hop was fetched; the rebound hop never was.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still fetches a public hostname normally', async () => {
    const fetchMock = vi.fn(async () => new Response('<edmx:Edmx/>', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await fetchWithPolicy('https://windchill.example.test/odata/$metadata', {
      resolveHostname: async () => ['93.184.216.34'],
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
