import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createHttpReferenceLoader } from '../src/services/referenceLoader.js';
import { fetchWithPolicy } from '../src/services/safeFetch.js';
import { metadataStore } from '../src/services/metadataStore.js';

const minimalCSDL = `<?xml version="1.0"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices><Schema Namespace="T" xmlns="http://docs.oasis-open.org/odata/ns/edm">
    <EntityType Name="Product"><Key><PropertyRef Name="Id"/></Key><Property Name="Id" Type="Edm.Int32"/></EntityType>
  </Schema></edmx:DataServices></edmx:Edmx>`;

/** An uploaded document whose reference resolves against the supplied baseUrl. */
const referencingDocument = `<?xml version="1.0"?>
<edmx:Edmx Version="4.01" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Main" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Thing"><Key><PropertyRef Name="Id"/></Key>
      <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
    </Schema>
    <edmx:Reference Uri="shared.xml"><edmx:Include Namespace="Ext" Alias="ext" /></edmx:Reference>
  </edmx:DataServices>
</edmx:Edmx>`;

const sharedDocument = `<?xml version="1.0"?>
<edmx:Edmx Version="4.01" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Ext" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Base"><Key><PropertyRef Name="Id"/></Key>
      <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

function redirectTo(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

function headersOf(init?: RequestInit): Headers {
  return new Headers(init?.headers);
}

// The SSRF guard resolves a hostname's addresses before fetching it. These tests
// are about header forwarding, so pin resolution to a public address instead of
// depending on `windchill.example.com` failing to resolve.
vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '93.184.216.34', family: 4 }],
}));

afterEach(() => {
  vi.unstubAllGlobals();
  metadataStore.clearAll();
});

describe('fetchWithPolicy caller headers', () => {
  it('sends caller headers on the initial request and a same-origin redirect hop', async () => {
    const inits: RequestInit[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        inits.push(init ?? {});
        if (String(input).endsWith('/odata/$metadata')) {
          return redirectTo('https://windchill.example.com/odata/v4/$metadata');
        }
        return new Response(minimalCSDL, { status: 200 });
      }),
    );

    const response = await fetchWithPolicy('https://windchill.example.com/odata/$metadata', {
      headers: { authorization: 'Bearer t' },
      resolveHostname: async () => ['93.184.216.34'],
    });

    expect(response.status).toBe(200);
    expect(inits).toHaveLength(2);
    expect(headersOf(inits[0]).get('authorization')).toBe('Bearer t');
    expect(headersOf(inits[1]).get('authorization')).toBe('Bearer t');
    expect(headersOf(inits[1]).get('accept')).toBe('application/xml, text/xml');
  });

  it('drops caller headers on a cross-origin redirect hop', async () => {
    const inits: RequestInit[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL, init?: RequestInit) => {
        inits.push(init ?? {});
        if (inits.length === 1) return redirectTo('https://cdn.example.com/other.xml');
        return new Response(minimalCSDL, { status: 200 });
      }),
    );

    const response = await fetchWithPolicy('https://windchill.example.com/odata/$metadata', {
      headers: { authorization: 'Bearer t' },
      resolveHostname: async () => ['93.184.216.34'],
    });

    expect(response.status).toBe(200);
    expect(headersOf(inits[0]).get('authorization')).toBe('Bearer t');
    expect(headersOf(inits[1]).get('authorization')).toBeNull();
    expect(headersOf(inits[1]).get('accept')).toBe('application/xml, text/xml');
  });

  it('keeps Accept applied when the caller overrides it', async () => {
    const inits: RequestInit[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL, init?: RequestInit) => {
        inits.push(init ?? {});
        return new Response(minimalCSDL, { status: 200 });
      }),
    );

    await fetchWithPolicy('https://windchill.example.com/odata/$metadata', {
      headers: { accept: 'application/json' },
      resolveHostname: async () => ['93.184.216.34'],
    });

    expect(headersOf(inits[0]).get('accept')).toBe('application/json');
  });
});

describe('createHttpReferenceLoader caller headers', () => {
  it('forwards headers to a same-origin reference', async () => {
    const inits: RequestInit[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL, init?: RequestInit) => {
        inits.push(init ?? {});
        return new Response(minimalCSDL, { status: 200 });
      }),
    );

    const loader = createHttpReferenceLoader({
      headers: { authorization: 'Bearer t' },
      rootUrl: 'https://windchill.example.com/odata/$metadata',
    });
    await loader('https://windchill.example.com/odata/sibling.xml');

    expect(headersOf(inits[0]).get('authorization')).toBe('Bearer t');
  });

  it('drops headers for a cross-origin reference', async () => {
    const inits: RequestInit[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL, init?: RequestInit) => {
        inits.push(init ?? {});
        return new Response(minimalCSDL, { status: 200 });
      }),
    );

    const loader = createHttpReferenceLoader({
      headers: { authorization: 'Bearer t' },
      rootUrl: 'https://windchill.example.com/odata/$metadata',
    });
    await loader('https://cdn.example.com/sibling.xml');

    expect(headersOf(inits[0]).get('authorization')).toBeNull();
  });

  it('sends no caller headers when no rootUrl is supplied', async () => {
    const inits: RequestInit[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL, init?: RequestInit) => {
        inits.push(init ?? {});
        return new Response(minimalCSDL, { status: 200 });
      }),
    );

    const loader = createHttpReferenceLoader({ headers: { authorization: 'Bearer t' } });
    await loader('https://windchill.example.com/odata/sibling.xml');

    expect(headersOf(inits[0]).get('authorization')).toBeNull();
  });
});

describe('parse routes forward caller headers', () => {
  it('POST /url forwards headers on the metadata fetch', async () => {
    const inits: RequestInit[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL, init?: RequestInit) => {
        inits.push(init ?? {});
        return new Response(minimalCSDL, { status: 200 });
      }),
    );

    const res = await request(createApp())
      .post('/api/parse/url')
      .send({
        url: 'https://windchill.example.com/odata/$metadata',
        headers: { authorization: 'Bearer t' },
      });

    expect(res.status).toBe(200);
    expect(headersOf(inits[0]).get('authorization')).toBe('Bearer t');
  });

  it('POST /url rejects invalid headers with 400 before fetching', async () => {
    const fetchMock = vi.fn(async () => new Response(minimalCSDL, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await request(createApp())
      .post('/api/parse/url')
      .send({
        url: 'https://windchill.example.com/odata/$metadata',
        headers: { host: 'evil.example.com' },
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/host/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POST /file rejects headers without baseUrl', async () => {
    const fetchMock = vi.fn(async () => new Response(minimalCSDL, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await request(createApp())
      .post('/api/parse/file')
      .field('headers', JSON.stringify({ authorization: 'Bearer t' }))
      .attach('metadata', Buffer.from(referencingDocument), {
        filename: 'main.xml',
        contentType: 'application/xml',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/headers require baseUrl/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POST /file forwards headers to same-origin reference fetches', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init: init ?? {} });
        return new Response(sharedDocument, { status: 200 });
      }),
    );

    const res = await request(createApp())
      .post('/api/parse/file')
      .field('baseUrl', 'https://windchill.example.com/odata/main.xml')
      .field('headers', JSON.stringify({ authorization: 'Bearer t' }))
      .attach('metadata', Buffer.from(referencingDocument), {
        filename: 'main.xml',
        contentType: 'application/xml',
      });

    expect(res.status).toBe(200);
    expect(calls.map((call) => call.url)).toEqual([
      'https://windchill.example.com/odata/shared.xml',
    ]);
    expect(headersOf(calls[0].init).get('authorization')).toBe('Bearer t');
  });

  it('POST /content rejects headers without baseUrl', async () => {
    const fetchMock = vi.fn(async () => new Response(sharedDocument, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await request(createApp())
      .post('/api/parse/content')
      .send({ content: referencingDocument, headers: { authorization: 'Bearer t' } });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/headers require baseUrl/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POST /content forwards headers to same-origin reference fetches', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init: init ?? {} });
        return new Response(sharedDocument, { status: 200 });
      }),
    );

    const res = await request(createApp())
      .post('/api/parse/content')
      .send({
        content: referencingDocument,
        baseUrl: 'https://windchill.example.com/odata/main.xml',
        headers: { authorization: 'Bearer t' },
      });

    expect(res.status).toBe(200);
    expect(calls.map((call) => call.url)).toEqual([
      'https://windchill.example.com/odata/shared.xml',
    ]);
    expect(headersOf(calls[0].init).get('authorization')).toBe('Bearer t');
  });
});
