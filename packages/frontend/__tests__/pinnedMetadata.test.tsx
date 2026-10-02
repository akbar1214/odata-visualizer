import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, cleanup } from '@testing-library/react';
import type { ODataEntity, ODataMetadata } from '@odata-visualizer/shared';
import App from '../src/App';

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

describe('metadata hydration UI', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the backend model on mount and sends the session header', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, pinned: false, metadata: makeMetadata(2), info: null }),
    );

    render(<App />);

    await waitFor(() => expect(screen.getByText('2 entities')).toBeDefined());
    expect(screen.queryByText('Visualize OData Metadata')).toBeNull();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/metadata/current');
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['X-Metadata-Session']).toBeTruthy();
  });

  it('shows the loading state until a pending hydration settles', async () => {
    const pending = deferred<Response>();
    fetchMock.mockImplementationOnce(() => pending.promise);

    render(<App />);

    expect(screen.getByText('Loading metadata...')).toBeDefined();
    expect(screen.queryByText('Visualize OData Metadata')).toBeNull();
    expect(screen.queryByText('Load OData Metadata')).toBeNull();

    await act(async () => {
      pending.resolve(jsonResponse({ success: true, pinned: false, metadata: null, info: null }));
    });

    await waitFor(() => expect(screen.getByText('Visualize OData Metadata')).toBeDefined());
  });

  it('shows the upload screen when the backend has no model', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, pinned: false, metadata: null, info: null }),
    );

    render(<App />);

    await waitFor(() => expect(screen.getByText('Visualize OData Metadata')).toBeDefined());
    expect(screen.queryByText('2 entities')).toBeNull();
  });

  it('falls back to the upload screen when hydration fails, without an error banner', async () => {
    fetchMock.mockResolvedValueOnce(new Response('down', { status: 503 }));

    render(<App />);

    await waitFor(() => expect(screen.getByText('Visualize OData Metadata')).toBeDefined());
    expect(screen.queryByText('Error')).toBeNull();
  });
});

describe('pinned metadata UI', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the pinned source and hides the upload and clear controls', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, pinned: true, metadata: makeMetadata(1), info: pinnedInfo }),
    );

    render(<App />);

    await waitFor(() => expect(screen.getByText('1 entities')).toBeDefined());
    expect(screen.getByText('Metadata pinned by the server: pinned.xml')).toBeDefined();
    expect(screen.queryByText('Load OData Metadata')).toBeNull();
    expect(screen.queryByRole('button', { name: 'New File' })).toBeNull();
    expect(
      fetchMock.mock.calls.every(
        ([, init]) => (init as RequestInit | undefined)?.method !== 'DELETE',
      ),
    ).toBe(true);
  });

  it('renders the pinned banner without a name when info is missing', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, pinned: true, metadata: makeMetadata(1), info: null }),
    );

    render(<App />);

    await waitFor(() => expect(screen.getByText('1 entities')).toBeDefined());
    expect(screen.getByText('Metadata pinned by the server')).toBeDefined();
    expect(screen.queryByText(/Metadata pinned by the server:/)).toBeNull();
  });
});
