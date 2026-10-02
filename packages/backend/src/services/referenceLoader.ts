import { fetchWithPolicy, urlPolicyFromEnv } from './safeFetch.js';

export interface HttpReferenceLoaderOptions {
  /**
   * Caller-supplied request headers, already validated by the caller. They are
   * credentials for the metadata server, so they are forwarded only to a
   * reference that shares `rootUrl`'s origin.
   */
  headers?: Record<string, string>;
  /** The document the references belong to; without it no headers are sent. */
  rootUrl?: string;
}

/** True when `uri` parses and shares `origin`; a relative or invalid one does not. */
function isSameOrigin(uri: string, origin: string): boolean {
  try {
    return new URL(uri).origin === origin;
  } catch {
    return false;
  }
}

/**
 * Build a loader for `edmx:Reference/@Uri` values that resolves them over
 * HTTP relative to the document, subject to the same allowlist/private-address
 * policy as /api/parse/url. Redirects are followed manually so a reference can
 * never be bounced to a private address.
 */
export function createHttpReferenceLoader(options: HttpReferenceLoaderOptions = {}) {
  const policy = urlPolicyFromEnv();
  const rootOrigin = options.rootUrl ? new URL(options.rootUrl).origin : undefined;

  return async (uri: string): Promise<string> => {
    const headers =
      options.headers && rootOrigin && isSameOrigin(uri, rootOrigin) ? options.headers : undefined;
    const response = await fetchWithPolicy(uri, {
      ...policy,
      accept: 'application/xml, text/xml',
      headers,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return response.text();
  };
}
