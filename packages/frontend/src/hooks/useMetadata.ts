import { useState, useCallback } from 'react';
import type { ODataMetadata, ParseResponse } from '@odata-visualizer/shared';
import { parseFile, parseUrl, clearMetadata } from '../services/api';

export interface MetadataState {
  metadata: ODataMetadata | null;
  loading: boolean;
  error: string | null;
  parseTimeMs: number | null;
  fileSizeBytes: number | null;
}

export function useMetadata() {
  const [state, setState] = useState<MetadataState>({
    metadata: null,
    loading: false,
    error: null,
    parseTimeMs: null,
    fileSizeBytes: null,
  });

  const handleResponse = useCallback((response: ParseResponse) => {
    if (response.success && response.data) {
      setState({
        metadata: response.data,
        loading: false,
        error: null,
        parseTimeMs: response.parseTimeMs,
        fileSizeBytes: response.fileSizeBytes,
      });
    } else {
      setState({
        metadata: null,
        loading: false,
        error: response.error || 'Unknown error',
        parseTimeMs: response.parseTimeMs,
        fileSizeBytes: response.fileSizeBytes,
      });
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
    setState({
      metadata: null,
      loading: false,
      error: null,
      parseTimeMs: null,
      fileSizeBytes: null,
    });
    void clearMetadata().catch(() => {
      // Best-effort: don't block clearing the UI if the backend is unreachable.
    });
  }, []);

  return {
    ...state,
    loadFile,
    loadUrl,
    clear,
  };
}
