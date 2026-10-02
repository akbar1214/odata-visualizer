import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { metadataStore, sanitizeModelId } from '../src/services/metadataStore.js';
import { fetchWithPolicy, readLimitedText } from '../src/services/safeFetch.js';

vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '93.184.216.34', family: 4 }],
}));

const minimalCSDL = `<?xml version="1.0"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices><Schema Namespace="T" xmlns="http://docs.oasis-open.org/odata/ns/edm">
    <EntityType Name="Product"><Key><PropertyRef Name="Id"/></Key><Property Name="Id" Type="Edm.Int32"/></EntityType>
  </Schema></edmx:DataServices></edmx:Edmx>`;

afterEach(() => {
  vi.unstubAllGlobals();
  metadataStore.clearAll();
});

/**
 * `app.use(cors())` reflected `Access-Control-Allow-Origin: *` on every route,
 * including the token-authenticated API and /mcp. Any web page the developer
 * visited could then drive the local backend with their browser as the network
 * position — reading the loaded model and using the server as an SSRF proxy.
 */
describe('CORS', () => {
  it('sends no CORS headers by default', async () => {
    const app = createApp();
    for (const path of ['/api/health', '/api/metadata/current', '/api/metadata']) {
      const res = await request(app).get(path);
      expect(res.headers['access-control-allow-origin'], `for ${path}`).toBeUndefined();
    }
  });

  it('answers a preflight without a wildcard when CORS is not configured', async () => {
    const app = createApp();
    const res = await request(app)
      .options('/api/metadata/current')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'GET');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('reflects an explicitly configured origin', async () => {
    const app = createApp({ corsOrigins: ['https://app.example.com'] });
    const res = await request(app).get('/api/health').set('Origin', 'https://app.example.com');
    expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('does not reflect an origin that is not configured', async () => {
    const app = createApp({ corsOrigins: ['https://app.example.com'] });
    const res = await request(app).get('/api/health').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not advertise the framework', async () => {
    const app = createApp();
    const res = await request(app).get('/api/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

/**
 * There was no error-handling middleware, so multer and body-parser failures
 * surfaced as HTML 500s containing a stack trace and absolute build paths, and
 * clients that read `body.success` got `undefined`.
 */
describe('error responses', () => {
  it('rejects a non-XML upload as JSON 400, not HTML 500', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/parse/file')
      .attach('metadata', Buffer.from('not xml at all'), {
        filename: 'notes.png',
        contentType: 'image/png',
      });

    expect(res.status).toBe(400);
    expect(res.type).toBe('application/json');
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/file type/i);
  });

  it('rejects an oversized JSON body as JSON 413', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/parse/content')
      .send({ content: 'x'.repeat(11 * 1024 * 1024) });

    expect(res.status).toBe(413);
    expect(res.type).toBe('application/json');
    expect(res.body.success).toBe(false);
  });

  it('never leaks a stack trace or absolute build path', async () => {
    const app = createApp();
    const res = await request(app).post('/api/parse/content').send({ content: '<not-csdl/>' });

    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/\bat .+\.ts:\d+/);
    expect(body).not.toMatch(/\/Users\/|\/home\//);
    expect(body).not.toMatch(/node_modules/);
  });
});

/** A malformed document is a caller error, not a server fault. */
describe('parse failures are caller errors', () => {
  it('returns 400 for a document that is not CSDL', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/parse/content')
      .send({ content: '<html>not a metadata document</html>' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/CSDL/i);
  });

  it('returns 400 for an unparsable upload', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/parse/file')
      .attach('metadata', Buffer.from('<html>nope</html>'), {
        filename: 'model.xml',
        contentType: 'application/xml',
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

/**
 * `AbortSignal.timeout` rejects with a DOMException named "TimeoutError", not
 * "AbortError", so the friendly message was unreachable dead code.
 */
describe('timeouts', () => {
  it('reports a timeout as 504 with a clear message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }),
    );

    const app = createApp();
    const res = await request(app)
      .post('/api/parse/url')
      .send({ url: 'https://windchill.example.com/odata/$metadata' });

    expect(res.status).toBe(504);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/timed out/i);
  });
});

/** `https://token@host/` is a common way to pass an API token in a URL. */
describe('URL credentials', () => {
  it('strips a username-only credential before fetching', async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        requested.push(String(input));
        return new Response(minimalCSDL, { status: 200 });
      }),
    );

    const app = createApp();
    const res = await request(app)
      .post('/api/parse/url')
      .send({ url: 'https://TOKENVALUE@windchill.example.com/odata/$metadata' });

    expect(res.status).toBe(200);
    // The token must not reach fetch, the stored source, or the response.
    expect(requested[0]).not.toContain('TOKENVALUE');
    expect(JSON.stringify(res.body)).not.toContain('TOKENVALUE');
  });

  it('strips a username and password pair', async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        requested.push(String(input));
        return new Response(minimalCSDL, { status: 200 });
      }),
    );

    const app = createApp();
    await request(app)
      .post('/api/parse/url')
      .send({ url: 'https://user:hunter2@windchill.example.com/odata/$metadata' });

    expect(requested[0]).not.toContain('hunter2');
    expect(requested[0]).not.toContain('user');
  });
});

describe('reported file size', () => {
  it('does not report NaN for a malformed Content-Length', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(minimalCSDL, {
            status: 200,
            headers: { 'content-length': 'not-a-number' },
          }),
      ),
    );

    const app = createApp();
    const res = await request(app)
      .post('/api/parse/url')
      .send({ url: 'https://windchill.example.com/odata/$metadata' });

    expect(res.status).toBe(200);
    expect(Number.isFinite(res.body.fileSizeBytes)).toBe(true);
  });

  it('reports byte length, not UTF-16 code units', async () => {
    const doc = minimalCSDL.replace('Product', 'Produkt-Ü-中文');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(doc, { status: 200 })),
    );

    const app = createApp();
    const res = await request(app)
      .post('/api/parse/url')
      .send({ url: 'https://windchill.example.com/odata/$metadata' });

    expect(res.status).toBe(200);
    // Buffer.byteLength(doc, 'utf8') counts the multi-byte characters once.
    expect(res.body.fileSizeBytes).toBe(Buffer.byteLength(doc, 'utf8'));
    expect(res.body.fileSizeBytes).not.toBe(doc.length);
  });
});

/** A 100 MB in-memory upload becomes a ~200 MB string, then a huge object graph. */
describe('resource limits', () => {
  it('refuses a metadata response larger than the cap', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('x'.repeat(64 * 1024), { status: 200 })),
    );

    const response = await fetchWithPolicy('https://windchill.example.com/odata/$metadata', {
      resolveHostname: async () => ['93.184.216.34'],
    });

    // The declared length is absent here, so the cap has to be enforced while
    // reading — which is what the caller uses.
    await expect(readLimitedText(response, 1024)).rejects.toThrow(/too large/i);
  });

  it('refuses a response whose declared Content-Length already exceeds the cap', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('small', {
            status: 200,
            headers: { 'content-length': '999999999999' },
          }),
      ),
    );

    await expect(
      fetchWithPolicy('https://windchill.example.com/odata/$metadata', {
        resolveHostname: async () => ['93.184.216.34'],
        maxResponseBytes: 1024,
      }),
    ).rejects.toThrow(/too large/i);
  });
  it('limits a single upload to a sane size', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/parse/file')
      .attach('metadata', Buffer.alloc(26 * 1024 * 1024, 0x20), {
        filename: 'huge.xml',
        contentType: 'application/xml',
      });

    expect(res.status).toBe(413);
    expect(res.body.success).toBe(false);
  });
});

/** Each redirect hop used to get its own 30 s budget, so the real worst case was 180 s. */
describe('redirect handling', () => {
  it('gives every hop the same deadline instead of a fresh one', async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL, init?: RequestInit) => {
        signals.push(init?.signal as AbortSignal);
        return new Response(null, {
          status: 302,
          headers: { location: 'https://windchill.example.com/next.xml' },
        });
      }),
    );

    await expect(
      fetchWithPolicy('https://windchill.example.com/odata/$metadata', {
        resolveHostname: async () => ['93.184.216.34'],
      }),
    ).rejects.toThrow(/too many redirects/i);

    expect(signals.length).toBeGreaterThan(1);
    // One shared AbortSignal means the timeout covers the whole chain; a
    // per-hop signal would make the worst case 6 x timeoutMs.
    expect(new Set(signals).size).toBe(1);
  });

  it('releases the socket held by a redirect response body', async () => {
    let cancelled = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        if (!String(input).includes('final')) {
          // A body that never ends: an undrained 302 pins the connection.
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(4096));
            },
            cancel() {
              cancelled = true;
            },
          });
          return new Response(stream, {
            status: 302,
            headers: { location: 'https://windchill.example.com/final.xml' },
          });
        }
        return new Response('<edmx:Edmx/>', { status: 200 });
      }),
    );

    const response = await fetchWithPolicy('https://windchill.example.com/odata/$metadata', {
      resolveHostname: async () => ['93.184.216.34'],
    });

    expect(response.status).toBe(200);
    expect(cancelled).toBe(true);
  });
});

describe('session isolation', () => {
  it('honours the multipart session field on /api/parse/file', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/parse/file')
      .field('session', 'from-multipart')
      .attach('metadata', Buffer.from(minimalCSDL), {
        filename: 'model.xml',
        contentType: 'application/xml',
      });

    expect(res.status).toBe(200);

    // The upload must be visible to the session named in the form, not to
    // "default".
    const listed = await request(app)
      .get('/api/metadata')
      .set('X-Metadata-Session', 'from-multipart');
    expect(listed.body.models.map((m: { id: string }) => m.id)).toEqual(['from-multipart']);
  });

  it('does not let one session list another session’s models', async () => {
    const app = createApp();
    await request(app)
      .post('/api/parse/content')
      .set('X-Metadata-Session', 'victim-tenant-42')
      .send({ content: minimalCSDL });

    const attacker = await request(app).get('/api/metadata');
    expect(JSON.stringify(attacker.body)).not.toContain('victim-tenant-42');
  });

  it('does not collapse distinct ids onto the shared default bucket', () => {
    // Stripping characters turned these into the same key.
    expect(sanitizeModelId('..')).not.toBe(sanitizeModelId(''));
    expect(sanitizeModelId('a/b')).not.toBe(sanitizeModelId('ab'));
    expect(sanitizeModelId('!!!')).not.toBe(sanitizeModelId(''));
  });

  it('still returns a stable id for a repeated value', () => {
    expect(sanitizeModelId('tab1')).toBe(sanitizeModelId('tab1'));
    expect(sanitizeModelId('tab1')).not.toBe(sanitizeModelId('tab2'));
  });
});
