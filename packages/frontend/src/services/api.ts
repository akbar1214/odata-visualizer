import type { ParseResponse } from '@odata-visualizer/shared';

const API_BASE = '/api';

/**
 * Parse OData metadata from uploaded file
 */
export async function parseFile(file: File): Promise<ParseResponse> {
  const formData = new FormData();
  formData.append('metadata', file);

  const response = await fetch(`${API_BASE}/parse/file`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Network error' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Parse OData metadata from URL
 */
export async function parseUrl(url: string): Promise<ParseResponse> {
  const response = await fetch(`${API_BASE}/parse/url`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Network error' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Parse OData metadata from raw XML content
 */
export async function parseContent(content: string): Promise<ParseResponse> {
  const response = await fetch(`${API_BASE}/parse/content`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Network error' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Clear the metadata currently held by the backend (and shared with MCP).
 */
export async function clearMetadata(): Promise<void> {
  await fetch(`${API_BASE}/metadata/current`, { method: 'DELETE' });
}

/**
 * Check backend health
 */
export async function checkHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/health`);
    return response.ok;
  } catch {
    return false;
  }
}
