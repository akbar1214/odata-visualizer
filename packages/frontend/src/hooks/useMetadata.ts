import { useState, useCallback, useEffect } from 'react';
import type { ODataMetadata, ParseResponse } from '@odata-visualizer/shared';
import { parseFile, parseUrl, clearMetadata, fetchCurrentMetadata } from '../services/api';

export interface MetadataState {
  metadata: ODataMetadata | null;
  loading: boolean;
  error: string | null;
  parseTimeMs: number | null;
  fileSizeBytes: number | null;
  pinned: boolean;
  sourceName: string | null;
  initializing: boolean;
}

export function useMetadata() {
  const [state, setState] = useState<MetadataState>({
    metadata: null,
    loading: false,
    error: null,
    parseTimeMs: null,
    fileSizeBytes: null,
    pinned: false,
    sourceName: null,
    initializing: true,
  });

  // A refresh should keep showing the model the backend still holds (pinned or
  // uploaded for this session). Failures fall through to the upload screen.
  useEffect(() => {
    let cancelled = false;

    async function hydrate() {
      try {
        const response = await fetchCurrentMetadata();
        if (cancelled) return;
        setState((prev) => ({
          ...prev,
          metadata: response.metadata,
          parseTimeMs: null,
          fileSizeBytes: response.info?.fileSizeBytes ?? null,
          pinned: response.pinned,
          sourceName: response.info?.sourceName ?? null,
          initializing: false,
        }));
      } catch {
        if (!cancelled) {
          setState((prev) => ({ ...prev, initializing: false }));
        }
      }
    }

    void hydrate();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleResponse = useCallback((response: ParseResponse) => {
    const data = response.data;
    if (response.success && data) {
      setState((prev) => ({
        ...prev,
        metadata: data,
        loading: false,
        error: null,
        parseTimeMs: response.parseTimeMs,
        fileSizeBytes: response.fileSizeBytes,
      }));
    } else {
      setState((prev) => ({
        ...prev,
        metadata: null,
        loading: false,
        error: response.error || 'Unknown error',
        parseTimeMs: response.parseTimeMs,
        fileSizeBytes: response.fileSizeBytes,
      }));
    }
  }, []);

  const loadFile = useCallback(
    async (file: File) => {
      setState((prev) => ({ ...prev, loading: true, error: null }));
      try {
        const response = await parseFile(file);
        handleResponse(response);
      } catch (error) {
        setState((prev) => ({
          ...prev,
          loading: false,
          error: error instanceof Error ? error.message : 'Failed to parse file',
        }));
      }
    },
    [handleResponse],
  );

  const loadUrl = useCallback(
    async (url: string) => {
      setState((prev) => ({ ...prev, loading: true, error: null }));
      try {
        const response = await parseUrl(url);
        handleResponse(response);
      } catch (error) {
        setState((prev) => ({
          ...prev,
          loading: false,
          error: error instanceof Error ? error.message : 'Failed to fetch metadata',
        }));
      }
    },
    [handleResponse],
  );

  const clear = useCallback(() => {
    // A pinned model cannot be cleared: the DELETE would 403.
    if (state.pinned) return;
    setState((prev) => ({
      ...prev,
      metadata: null,
      loading: false,
      error: null,
      parseTimeMs: null,
      fileSizeBytes: null,
    }));
    void clearMetadata().catch(() => {
      // Best-effort: don't block clearing the UI if the backend is unreachable.
    });
  }, [state.pinned]);

  return {
    ...state,
    loadFile,
    loadUrl,
    clear,
  };
}
