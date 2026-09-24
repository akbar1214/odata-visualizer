import { fetchWithPolicy, urlPolicyFromEnv } from './safeFetch.js';

/**
 * Build a loader for `edmx:Reference/@Uri` values that resolves them over
 * HTTP relative to the document, subject to the same allowlist/private-address
 * policy as /api/parse/url. Redirects are followed manually so a reference can
 * never be bounced to a private address.
 */
export function createHttpReferenceLoader() {
  const policy = urlPolicyFromEnv();

  return async (uri: string): Promise<string> => {
    const response = await fetchWithPolicy(uri, {
      ...policy,
      accept: 'application/xml, text/xml',
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return response.text();
  };
}
