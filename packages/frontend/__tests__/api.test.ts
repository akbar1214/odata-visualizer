import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseContent,
  parseUrl,
  clearMetadata,
  fetchCurrentMetadata,
  setApiToken,
} from '../src/services/api';

describe('API token support', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setApiToken(undefined);
  });

  it('sends the configured token as a bearer header', async () => {
    setApiToken('sekret');
    await parseContent('<x/>');
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sekret');
  });

  it('still sends the session header alongside the token', async () => {
    setApiToken('sekret');
    await parseContent('<x/>');
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['X-Metadata-Session']).toBeTruthy();
  });

  it('omits the header when no token is configured', async () => {
    setApiToken(undefined);
    await parseContent('<x/>');
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  it('sends the token on every API call, including clear', async () => {
    setApiToken('sekret');
    await parseContent('<x/>');
    await clearMetadata();
    for (const call of fetchMock.mock.calls) {
      const headers = (call[1] as RequestInit).headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer sekret');
    }
  });
});

describe('parseUrl request headers', () => {
  const METADATA_URL = 'https://example.com/$metadata';
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function sentBody(): Record<string, unknown> {
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    return JSON.parse(init.body as string) as Record<string, unknown>;
  }

  it('posts the headers next to the URL', async () => {
    await parseUrl(METADATA_URL, { Authorization: 'Bearer tok' });

    expect(sentBody()).toEqual({
      url: METADATA_URL,
      headers: { Authorization: 'Bearer tok' },
    });
  });

  it('omits the headers key when the caller supplies none', async () => {
    await parseUrl(METADATA_URL);

    const body = sentBody();
    expect(body).toEqual({ url: METADATA_URL });
    expect('headers' in body).toBe(false);
  });

  it('omits the headers key when the supplied object is empty', async () => {
    await parseUrl(METADATA_URL, {});

    expect('headers' in sentBody()).toBe(false);
  });
});

describe('fetchCurrentMetadata', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the current model with the session header', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          pinned: true,
          metadata: { entities: [], relationships: [] },
          info: { sourceName: 'pinned.xml', fileSizeBytes: 2048 },
        }),
        { status: 200 },
      ),
    );

    const result = await fetchCurrentMetadata();

    expect(result.pinned).toBe(true);
    expect(result.info?.sourceName).toBe('pinned.xml');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/metadata/current');
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['X-Metadata-Session']).toBeTruthy();
  });

  it('rejects on a non-OK response', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'nope' }), { status: 500 }),
    );
    await expect(fetchCurrentMetadata()).rejects.toThrow('nope');
  });

  it('clears the timeout after a successful response', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, pinned: false, metadata: null, info: null }), {
          status: 200,
        }),
      );

      await fetchCurrentMetadata();

      // No hydration timer may outlive the request.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
