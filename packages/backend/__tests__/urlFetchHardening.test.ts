import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { metadataStore } from '../src/services/metadataStore.js';

const minimalCSDL = `<?xml version="1.0"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices><Schema Namespace="T" xmlns="http://docs.oasis-open.org/odata/ns/edm">
    <EntityType Name="Product"><Key><PropertyRef Name="Id"/></Key><Property Name="Id" Type="Edm.Int32"/></EntityType>
  </Schema></edmx:DataServices></edmx:Edmx>`;

/** A metadata document that references a private address. */
const referencingPrivateHost = `<?xml version="1.0"?>
<edmx:Edmx Version="4.01" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="T" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Product"><Key><PropertyRef Name="Id"/></Key><Property Name="Id" Type="Edm.Int32"/></EntityType>
    </Schema>
    <edmx:Reference Uri="http://169.254.169.254/latest/meta-data/">
      <edmx:Include Namespace="Evil" Alias="evil" />
    </edmx:Reference>
  </edmx:DataServices>
</edmx:Edmx>`;

function responseWithUrl(body: string, url: string) {
  const response = new Response(body, { status: 200 });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  metadataStore.clearAll();
});

describe('GET /api/parse/url hardening', () => {
  it('does not follow an edmx:Reference to a private address', async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        requested.push(String(input));
        return new Response(referencingPrivateHost, { status: 200 });
      }),
    );

    const app = createApp();
    const res = await request(app)
      .post('/api/parse/url')
      .send({ url: 'https://windchill.example.com/odata/$metadata' });

    expect(res.status).toBe(200);
    // The private address must never be requested.
    expect(requested).toEqual(['https://windchill.example.com/odata/$metadata']);
    // ...and the unresolved reference is reported rather than swallowed.
    expect(res.body.data.unresolvedReferences).toEqual([
      'http://169.254.169.254/latest/meta-data/',
    ]);
  });

  it('fetches the top-level URL exactly once', async () => {
    const fetchMock = vi.fn(async () => new Response(minimalCSDL, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const app = createApp();
    const res = await request(app)
      .post('/api/parse/url')
      .send({ url: 'https://windchill.example.com/odata/$metadata' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // A second fetch meant the parsed document could differ from the reported
    // size (TOCTOU) and doubled the bandwidth.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports the size of the document it actually parsed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(minimalCSDL, {
            status: 200,
            headers: { 'content-length': String(minimalCSDL.length) },
          }),
      ),
    );

    const app = createApp();
    const res = await request(app)
      .post('/api/parse/url')
      .send({ url: 'https://windchill.example.com/odata/$metadata' });
    expect(res.body.fileSizeBytes).toBe(minimalCSDL.length);
  });

  it('rejects a response that redirects to a private address', async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        requested.push(String(input));
        expect(init?.redirect).toBe('manual');
        // The public URL 302s to the cloud metadata endpoint.
        return new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        });
      }),
    );

    const app = createApp();
    const res = await request(app)
      .post('/api/parse/url')
      .send({ url: 'https://windchill.example.com/odata/$metadata' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/private or loopback/i);
    // The private hop is never requested.
    expect(requested).toEqual(['https://windchill.example.com/odata/$metadata']);
  });

  it('accepts a response that stayed on an allowed host', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(minimalCSDL, {
            status: 200,
            headers: { 'content-type': 'application/xml' },
          }),
      ),
    );

    const app = createApp();
    const res = await request(app)
      .post('/api/parse/url')
      .send({ url: 'https://windchill.example.com/odata/$metadata' });
    expect(res.status).toBe(200);
  });
});
