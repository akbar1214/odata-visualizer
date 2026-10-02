import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act, cleanup } from '@testing-library/react';
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
