import type { ParseResponse } from '@odata-visualizer/shared';

const API_BASE = '/api';

/**
 * Per-tab session id so concurrent browser sessions keep their own uploaded
 * model on the backend (MCP always sees the most recent one).
 */
function getSessionId(): string {
  if (typeof window === 'undefined') return 'default';
  const key = 'odata-visualizer-session';
  try {
    const existing = window.sessionStorage.getItem(key);
    if (existing) return existing;
    const created =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2);
    window.sessionStorage.setItem(key, created);
    return created;
  } catch {
    return 'default';
  }
}

const SESSION_HEADERS: Record<string, string> = {
  'X-Metadata-Session': getSessionId(),
};

/**
 * Parse OData metadata from uploaded file
 */
export async function parseFile(file: File): Promise<ParseResponse> {
  const formData = new FormData();
  formData.append('metadata', file);

  const response = await fetch(`${API_BASE}/parse/file`, {
    method: 'POST',
    headers: SESSION_HEADERS,
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
      ...SESSION_HEADERS,
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
      ...SESSION_HEADERS,
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
 * Clear the metadata currently held by the backend for this session.
 */
export async function clearMetadata(): Promise<void> {
  await fetch(`${API_BASE}/metadata/current`, {
    method: 'DELETE',
    headers: SESSION_HEADERS,
  });
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
