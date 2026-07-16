import { useState, useCallback } from 'react';
import type { ODataMetadata, ParseResponse } from '@odata-visualizer/shared';
import { parseFile, parseUrl } from '../services/api';

export interface MetadataState {
  metadata: ODataMetadata | null;
  loading: boolean;
  error: string | null;
  parseTimeMs: number | null;
  fileSizeBytes: number | null;
  sessionId: string | null;
}

export function useMetadata() {
  const [state, setState] = useState<MetadataState>({
    metadata: null,
    loading: false,
    error: null,
    parseTimeMs: null,
    fileSizeBytes: null,
    sessionId: null,
  });

  const handleResponse = useCallback((response: ParseResponse, sessionId: string) => {
    if (response.success && response.data) {
      setState({
        metadata: response.data,
        loading: false,
        error: null,
        parseTimeMs: response.parseTimeMs,
        fileSizeBytes: response.fileSizeBytes,
        sessionId,
      });
    } else {
      setState({
        metadata: null,
        loading: false,
        error: response.error || 'Unknown error',
        parseTimeMs: response.parseTimeMs,
        fileSizeBytes: response.fileSizeBytes,
        sessionId: null,
      });
    }
  }, []);

  const loadFile = useCallback(async (file: File) => {
    const sessionId = crypto.randomUUID();
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const response = await parseFile(file, sessionId);
      handleResponse(response, sessionId);
    } catch (error) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: error instanceof Error ? error.message : 'Failed to parse file',
        sessionId: null,
      }));
    }
  }, [handleResponse]);

  const loadUrl = useCallback(async (url: string) => {
    const sessionId = crypto.randomUUID();
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const response = await parseUrl(url, sessionId);
      handleResponse(response, sessionId);
    } catch (error) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: error instanceof Error ? error.message : 'Failed to fetch metadata',
        sessionId: null,
      }));
    }
  }, [handleResponse]);

  const clear = useCallback(() => {
    setState({
      metadata: null,
      loading: false,
      error: null,
      parseTimeMs: null,
      fileSizeBytes: null,
      sessionId: null,
    });
  }, []);

  return {
    ...state,
    loadFile,
    loadUrl,
    clear,
  };
}
