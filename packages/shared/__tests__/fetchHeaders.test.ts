import { describe, it, expect, afterEach, vi } from 'vitest';
import { parseCSDLUrl, validateFetchHeaders } from '../src/load.js';

const rootDocument = `<?xml version="1.0"?>
<edmx:Edmx Version="4.01" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Root" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Thing"><Property Name="Id" Type="Edm.String" /></EntityType>
    </Schema>
    <edmx:Reference Uri="https://api.example.com/odata/shared.xml">
      <edmx:Include Namespace="Ext" Alias="ext" />
    </edmx:Reference>
  </edmx:DataServices>
</edmx:Edmx>`;

const crossOriginDocument = rootDocument.replace(
  'https://api.example.com/odata/shared.xml',
  'https://cdn.example.com/shared.xml',
);

/** A document with no references, for tests about the root fetch alone. */
const plainDocument = rootDocument.replace(/\n    <edmx:Reference[\s\S]*?<\/edmx:Reference>/, '');

const sharedDocument = `<?xml version="1.0"?>
<edmx:Edmx Version="4.01" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Ext" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Base"><Key><PropertyRef Name="Id"/></Key>
      <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

interface FetchCall {
  url: string;
  headers: Headers;
  init?: RequestInit;
}

/** Serve the given documents and record the headers every request carried. */
function stubFetch(documents: Record<string, string>): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: new Headers(init?.headers), init });
      const body = documents[url];
      if (!body) throw new Error(`unexpected fetch: ${url}`);
      return new Response(body, { status: 200 });
    }),
  );
  return calls;
}

/** Record every request and answer each with `handler`. */
function stubFetchWith(handler: (url: string) => Response): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: new Headers(init?.headers), init });
      return handler(url);
    }),
  );
  return calls;
}

function redirectTo(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('validateFetchHeaders', () => {
  it('rejects a CRLF sequence in a header name', () => {
    expect(() => validateFetchHeaders({ 'x-evil\r\ninjected': '1' })).toThrow(
      /not a valid HTTP header name/,
    );
  });

  it('rejects a space in a header name', () => {
    expect(() => validateFetchHeaders({ 'x evil': '1' })).toThrow(/not a valid HTTP header name/);
  });

  it('rejects CR, LF and NUL in a header value', () => {
    for (const value of ['Bearer\r\nX', 'Bearer\nX', 'Bearer\0X']) {
      expect(() => validateFetchHeaders({ authorization: value })).toThrow(
        /invalid character in its value/,
      );
    }
  });

  it('rejects C0 controls other than HTAB, and DEL', () => {
    for (const value of [
      'Bearer\0X',
      'Bearer\u0001X',
      'Bearer\u000bX',
      'Bearer\u001fX',
      'Bearer\u007fX',
    ]) {
      expect(() => validateFetchHeaders({ authorization: value })).toThrow(
        /invalid character in its value/,
      );
    }
  });

  it('accepts a horizontal tab in a header value', () => {
    expect(validateFetchHeaders({ 'x-note': 'a\tb' })).toEqual({ 'x-note': 'a\tb' });
  });

  it('rejects characters above U+00FF', () => {
    // `Headers.set` needs a ByteString; without this, fetch throws and the
    // route reports what is really a caller error as a 500.
    for (const value of ['caf\u20ac', 'a\ud83d\ude00b', 'a\u0100b']) {
      expect(() => validateFetchHeaders({ 'x-api-key': value })).toThrow(
        /invalid character in its value/,
      );
    }
  });

  it('accepts Latin-1 obs-text', () => {
    expect(validateFetchHeaders({ 'x-note': 'caf\u00e9' })).toEqual({ 'x-note': 'caf\u00e9' });
  });

  it('rejects framing and hop-by-hop headers', () => {
    for (const name of [
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
    ]) {
      expect(() => validateFetchHeaders({ [name]: 'x' }), name).toThrow(/not allowed/);
    }
  });

  it('rejects more than 20 headers', () => {
    const headers = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`x-h${i}`, 'v']));
    expect(() => validateFetchHeaders(headers)).toThrow(/too many headers/i);
  });

  it('rejects a header name longer than 64 characters', () => {
    expect(() => validateFetchHeaders({ ['x'.repeat(65)]: 'v' })).toThrow(/longer than 64/);
  });

  it('rejects a header value longer than 4096 characters', () => {
    expect(() => validateFetchHeaders({ authorization: 'v'.repeat(4097) })).toThrow(
      /longer than 4096/,
    );
  });

  it('rejects a set of headers whose total size exceeds 16 KB', () => {
    const headers = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`x-h${i}`, 'v'.repeat(4000)]),
    );
    expect(() => validateFetchHeaders(headers)).toThrow(/larger than the 16384-byte limit/);
  });

  it('never includes a header value in the error message', () => {
    const secret = 'super-secret-token';
    let message = '';
    try {
      validateFetchHeaders({ authorization: `Bearer ${secret}\r\n` });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(secret);
    expect(message).not.toContain('Bearer');
  });

  it('rejects duplicate names case-insensitively', () => {
    expect(() => validateFetchHeaders({ Authorization: 'a', authorization: 'b' })).toThrow(
      /duplicate header/i,
    );
  });

  it('returns a normalized copy with lower-cased names', () => {
    const input = { Authorization: 'Bearer t', 'X-Api-Key': 'k' };
    const result = validateFetchHeaders(input);
    expect(result).toEqual({ authorization: 'Bearer t', 'x-api-key': 'k' });
    expect(result).not.toBe(input);
  });
});

describe('parseCSDLUrl header forwarding', () => {
  it('sends caller headers on the root fetch', async () => {
    const calls = stubFetch({ 'https://api.example.com/odata/$metadata': plainDocument });

    await parseCSDLUrl('https://api.example.com/odata/$metadata', {
      headers: { authorization: 'Bearer t' },
    });

    expect(calls.map((call) => call.url)).toEqual(['https://api.example.com/odata/$metadata']);
    expect(calls[0].headers.get('authorization')).toBe('Bearer t');
  });

  it('forwards headers to a same-origin edmx:Reference', async () => {
    const calls = stubFetch({
      'https://api.example.com/odata/$metadata': rootDocument,
      'https://api.example.com/odata/shared.xml': sharedDocument,
    });

    await parseCSDLUrl('https://api.example.com/odata/$metadata', {
      headers: { authorization: 'Bearer t' },
    });

    expect(calls.map((call) => call.url)).toEqual([
      'https://api.example.com/odata/$metadata',
      'https://api.example.com/odata/shared.xml',
    ]);
    expect(calls[1].headers.get('authorization')).toBe('Bearer t');
  });

  it('does not forward headers to a cross-origin edmx:Reference', async () => {
    const calls = stubFetch({
      'https://api.example.com/odata/$metadata': crossOriginDocument,
      'https://cdn.example.com/shared.xml': sharedDocument,
    });

    await parseCSDLUrl('https://api.example.com/odata/$metadata', {
      headers: { authorization: 'Bearer t' },
    });

    expect(calls.map((call) => call.url)).toEqual([
      'https://api.example.com/odata/$metadata',
      'https://cdn.example.com/shared.xml',
    ]);
    expect(calls[1].headers.get('authorization')).toBeNull();
    expect(calls[1].headers.get('accept')).toBe('application/xml, text/xml');
  });

  it('rejects invalid headers before any fetch', async () => {
    const calls = stubFetch({});

    await expect(
      parseCSDLUrl('https://api.example.com/odata/$metadata', { headers: { host: 'evil' } }),
    ).rejects.toThrow(/not allowed/);
    expect(calls).toHaveLength(0);
  });

  it('rejects falsy non-object headers before any fetch', async () => {
    const calls = stubFetch({});

    // A truthiness check would skip validation for these and fetch
    // unauthenticated, the same silent drop the non-url guard prevents.
    for (const headers of [null, '', 0, false]) {
      await expect(
        parseCSDLUrl('https://api.example.com/odata/$metadata', {
          headers: headers as unknown as Record<string, string>,
        }),
      ).rejects.toThrow('Headers must be an object of string values');
    }
    expect(calls).toHaveLength(0);
  });

  it('treats an empty headers object as no headers', async () => {
    const calls = stubFetch({ 'https://api.example.com/odata/$metadata': plainDocument });

    await parseCSDLUrl('https://api.example.com/odata/$metadata', { headers: {} });

    expect(calls).toHaveLength(1);
    expect([...calls[0].headers.keys()]).toEqual(['accept']);
  });
});

describe('parseCSDLUrl manual redirects', () => {
  const rootUrl = 'https://api.example.com/odata/$metadata';

  it('drops caller headers when the root fetch redirects cross-origin', async () => {
    const calls = stubFetchWith((url) => {
      if (url === rootUrl) return redirectTo('https://cdn.example.com/odata/$metadata');
      if (url === 'https://cdn.example.com/odata/$metadata') {
        return new Response(plainDocument, { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const metadata = await parseCSDLUrl(rootUrl, { headers: { 'x-api-key': 'secret' } });

    expect(calls.map((call) => call.url)).toEqual([
      rootUrl,
      'https://cdn.example.com/odata/$metadata',
    ]);
    // Automatic following is what leaks a custom credential cross-origin.
    expect(calls.map((call) => call.init?.redirect)).toEqual(['manual', 'manual']);
    expect(calls[0].headers.get('x-api-key')).toBe('secret');
    expect(calls[1].headers.get('x-api-key')).toBeNull();
    expect(metadata.entities.map((entity) => entity.qualifiedName)).toContain('Root.Thing');
  });

  it('keeps caller headers when the root fetch redirects same-origin', async () => {
    const calls = stubFetchWith((url) => {
      if (url === rootUrl) return redirectTo('/odata/v4/$metadata');
      return new Response(plainDocument, { status: 200 });
    });

    await parseCSDLUrl(rootUrl, { headers: { 'x-api-key': 'secret' } });

    expect(calls.map((call) => call.url)).toEqual([
      rootUrl,
      'https://api.example.com/odata/v4/$metadata',
    ]);
    expect(calls.map((call) => call.init?.redirect)).toEqual(['manual', 'manual']);
    expect(calls[1].headers.get('x-api-key')).toBe('secret');
  });

  it('drops caller headers when a same-origin reference redirects cross-origin', async () => {
    const referenceUrl = 'https://api.example.com/odata/shared.xml';
    const calls = stubFetchWith((url) => {
      if (url === rootUrl) return new Response(rootDocument, { status: 200 });
      if (url === referenceUrl) return redirectTo('https://cdn.example.com/shared.xml');
      if (url === 'https://cdn.example.com/shared.xml') {
        return new Response(sharedDocument, { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await parseCSDLUrl(rootUrl, { headers: { 'x-api-key': 'secret' } });

    expect(calls.map((call) => call.url)).toEqual([
      rootUrl,
      referenceUrl,
      'https://cdn.example.com/shared.xml',
    ]);
    expect(calls.map((call) => call.init?.redirect)).toEqual(['manual', 'manual', 'manual']);
    expect(calls[1].headers.get('x-api-key')).toBe('secret');
    expect(calls[2].headers.get('x-api-key')).toBeNull();
  });

  it('cancels a redirect hop body before following it', async () => {
    const cancel = vi.fn();
    const hopBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('discarded'));
      },
      cancel,
    });
    const calls = stubFetchWith((url) => {
      if (url === rootUrl) {
        return new Response(hopBody, { status: 302, headers: { location: '/odata/v4/$metadata' } });
      }
      return new Response(plainDocument, { status: 200 });
    });

    await parseCSDLUrl(rootUrl, { headers: { 'x-api-key': 'secret' } });

    expect(calls).toHaveLength(2);
    // An undrained body pins the connection instead of returning it to the pool.
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('gives up after too many redirects', async () => {
    const calls = stubFetchWith((url) => redirectTo(`${url}?hop`));

    await expect(parseCSDLUrl(rootUrl, { headers: { 'x-api-key': 'secret' } })).rejects.toThrow(
      /too many redirects/i,
    );
    expect(calls).toHaveLength(6);
    expect(calls.every((call) => call.init?.redirect === 'manual')).toBe(true);
  });
});
