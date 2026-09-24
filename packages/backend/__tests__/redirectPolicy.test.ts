import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createHttpReferenceLoader } from '../src/services/referenceLoader.js';
import { metadataStore } from '../src/services/metadataStore.js';

const minimalCSDL = `<?xml version="1.0"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices><Schema Namespace="T" xmlns="http://docs.oasis-open.org/odata/ns/edm">
    <EntityType Name="Product"><Key><PropertyRef Name="Id"/></Key><Property Name="Id" Type="Edm.Int32"/></EntityType>
  </Schema></edmx:DataServices></edmx:Edmx>`;

function redirectTo(location: string, status = 302) {
  return new Response(null, { status, headers: { location } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  metadataStore.clearAll();
});

describe('redirect handling', () => {
  it('never requests a redirect target on a private address', async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        requested.push(String(input));
        // The public URL redirects to the cloud metadata endpoint.
        expect(init?.redirect).toBe('manual');
        return redirectTo('http://169.254.169.254/latest/meta-data/');
      }),
    );

    const app = createApp();
    const res = await request(app)
      .post('/api/parse/url')
      .send({ url: 'https://windchill.example.com/odata/$metadata' });

    expect(res.status).toBe(400);
    // The side effect is prevented, not merely detected after the fact.
    expect(requested).toEqual(['https://windchill.example.com/odata/$metadata']);
  });

  it('follows a redirect that stays on allowed hosts', async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        requested.push(url);
        if (url === 'https://windchill.example.com/odata/$metadata') {
          return redirectTo('https://windchill.example.com/odata/v4/$metadata');
        }
        return new Response(minimalCSDL, { status: 200 });
      }),
    );

    const app = createApp();
    const res = await request(app)
      .post('/api/parse/url')
      .send({ url: 'https://windchill.example.com/odata/$metadata' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(requested).toEqual([
      'https://windchill.example.com/odata/$metadata',
      'https://windchill.example.com/odata/v4/$metadata',
    ]);
  });

  it('gives up after too many redirects', async () => {
    let hop = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        hop += 1;
        return redirectTo(`https://windchill.example.com/hop/${hop}`);
      }),
    );

    const app = createApp();
    const res = await request(app)
      .post('/api/parse/url')
      .send({ url: 'https://windchill.example.com/odata/$metadata' });

    expect(res.status).toBe(502);
    expect(hop).toBeLessThanOrEqual(6);
  });

  it('applies the same redirect policy to edmx:Reference loads', async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        requested.push(url);
        expect(init?.redirect).toBe('manual');
        if (url.endsWith('sibling.xml')) {
          return redirectTo('http://10.0.0.5/internal.xml');
        }
        return new Response(minimalCSDL, { status: 200 });
      }),
    );

    const loader = createHttpReferenceLoader();
    await expect(loader('https://windchill.example.com/odata/sibling.xml')).rejects.toThrow(
      /private or loopback/i,
    );
    expect(requested).toEqual(['https://windchill.example.com/odata/sibling.xml']);
  });

  it('still resolves references normally', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith('sibling.xml')) {
          return new Response(minimalCSDL, { status: 200 });
        }
        return redirectTo('https://windchill.example.com/odata/other.xml');
      }),
    );

    const loader = createHttpReferenceLoader();
    const body = await loader('https://windchill.example.com/odata/sibling.xml');
    expect(body).toContain('Product');
  });
});
