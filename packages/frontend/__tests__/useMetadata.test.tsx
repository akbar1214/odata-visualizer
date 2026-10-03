import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act, cleanup } from '@testing-library/react';
import { StrictMode } from 'react';
import type { ODataEntity, ODataMetadata } from '@odata-visualizer/shared';
import { useMetadata } from '../src/hooks/useMetadata';

function makeEntity(index: number): ODataEntity {
  return {
    name: `Type${index}`,
    qualifiedName: `Pinned.Type${index}`,
    namespace: 'Pinned',
    kind: 'entity',
    abstract: false,
    openType: false,
    properties: [],
    navigationProperties: [],
    keys: ['Id'],
  };
}

function makeMetadata(count: number): ODataMetadata {
  return {
    entities: Array.from({ length: count }, (_, i) => makeEntity(i)),
    relationships: [],
    entityContainers: [],
    functionImports: [],
    actionImports: [],
    actions: [],
    functions: [],
    enumTypes: [],
    typeDefinitions: [],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const pinnedInfo = {
  sourceName: 'pinned.xml',
  sourceType: 'file',
  fileSizeBytes: 2048,
  loadedAt: '2026-01-01T00:00:00.000Z',
};

describe('useMetadata hydration', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('stays initializing until the first hydration fetch settles', async () => {
    let settle: ((response: Response) => void) | undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          settle = resolve;
        }),
    );

    const { result } = renderHook(() => useMetadata());
    expect(result.current.initializing).toBe(true);

    await act(async () => {
      settle?.(
        jsonResponse({ success: true, pinned: false, metadata: makeMetadata(1), info: null }),
      );
    });

    await waitFor(() => expect(result.current.initializing).toBe(false));
    expect(result.current.metadata?.entities).toHaveLength(1);
    expect(result.current.parseTimeMs).toBeNull();
  });

  it('records the pinned flag and source name from hydration', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, pinned: true, metadata: makeMetadata(1), info: pinnedInfo }),
    );

    const { result } = renderHook(() => useMetadata());

    await waitFor(() => expect(result.current.initializing).toBe(false));
    expect(result.current.pinned).toBe(true);
    expect(result.current.sourceName).toBe('pinned.xml');
    expect(result.current.fileSizeBytes).toBe(2048);
  });

  it('ignores a stale hydration response from a superseded mount', async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    fetchMock
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const { result } = renderHook(() => useMetadata(), { wrapper: StrictMode });

    // StrictMode mounts the effect twice, so the first fetch is superseded.
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve(
        jsonResponse({ success: true, pinned: false, metadata: makeMetadata(2), info: null }),
      );
    });
    await waitFor(() => expect(result.current.metadata?.entities).toHaveLength(2));

    await act(async () => {
      first.resolve(
        jsonResponse({ success: true, pinned: false, metadata: makeMetadata(1), info: null }),
      );
    });

    expect(result.current.metadata?.entities).toHaveLength(2);
  });
});

describe('useMetadata loadUrl', () => {
  const METADATA_URL = 'https://example.com/$metadata';
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return jsonResponse({
          success: true,
          data: makeMetadata(1),
          parseTimeMs: 3,
          fileSizeBytes: 128,
        });
      }
      return jsonResponse({ success: true, pinned: false, metadata: null, info: null });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function postedBodies(): Record<string, unknown>[] {
    return fetchMock.mock.calls
      .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
      .map(
        ([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, unknown>,
      );
  }

  it('forwards the headers with the metadata request', async () => {
    const { result } = renderHook(() => useMetadata());
    await waitFor(() => expect(result.current.initializing).toBe(false));

    await act(async () => {
      await result.current.loadUrl(METADATA_URL, { Authorization: 'Bearer tok' });
    });

    expect(postedBodies()).toEqual([
      { url: METADATA_URL, headers: { Authorization: 'Bearer tok' } },
    ]);
    expect(result.current.error).toBeNull();
  });

  it('sends no headers key when the caller supplies none', async () => {
    const { result } = renderHook(() => useMetadata());
    await waitFor(() => expect(result.current.initializing).toBe(false));

    await act(async () => {
      await result.current.loadUrl(METADATA_URL);
    });

    const bodies = postedBodies();
    expect(bodies).toEqual([{ url: METADATA_URL }]);
    expect('headers' in bodies[0]).toBe(false);
  });
});

describe('useMetadata clear', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('calls the API and clears state when unpinned', async () => {
    fetchMock.mockImplementation(async (_input: unknown, init?: RequestInit) => {
      if (init?.method === 'DELETE') return jsonResponse({ success: true });
      return jsonResponse({ success: true, pinned: false, metadata: makeMetadata(1), info: null });
    });

    const { result } = renderHook(() => useMetadata());
    await waitFor(() => expect(result.current.initializing).toBe(false));
    expect(result.current.metadata).not.toBeNull();

    await act(async () => {
      result.current.clear();
    });

    await waitFor(() => expect(result.current.metadata).toBeNull());
    expect(
      fetchMock.mock.calls.some(
        ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE',
      ),
    ).toBe(true);
  });

  it('does not call DELETE when pinned', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, pinned: true, metadata: makeMetadata(1), info: pinnedInfo }),
    );

    const { result } = renderHook(() => useMetadata());
    await waitFor(() => expect(result.current.initializing).toBe(false));

    await act(async () => {
      result.current.clear();
    });

    expect(result.current.metadata).not.toBeNull();
    expect(result.current.pinned).toBe(true);
    expect(
      fetchMock.mock.calls.some(
        ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE',
      ),
    ).toBe(false);
  });
});
