import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseContent, clearMetadata, setApiToken } from '../src/services/api';

describe('API token support', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ success: true }), { status: 200 }),
    );
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
