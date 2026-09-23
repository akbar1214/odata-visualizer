import { parseCSDL, type ODataMetadata } from '@odata-visualizer/shared';
import { parseCSDLFile, parseCSDLUrl } from '@odata-visualizer/shared/load';
import type { MetadataSourceType } from './store.js';

export interface MetadataSource {
  type: MetadataSourceType;
  /** File path, URL, or backend base URL. Omitted for a default backend. */
  path?: string;
}

export const DEFAULT_BACKEND_URL = 'http://localhost:3001';

export async function loadMetadataFromSource(source: MetadataSource): Promise<ODataMetadata> {
  if (source.type === 'server') {
    return loadFromBackend(source.path);
  }

  if (source.type === 'file') {
    if (!source.path) throw new Error('File path is required');
    return parseCSDLFile(source.path);
  }

  if (!source.path) throw new Error('URL is required');
  return parseCSDLUrl(source.path, {
    accept: 'application/xml, text/xml, application/atomsvc+xml',
  });
}

/** Fetch the metadata the backend currently holds for the uploaded file. */
async function loadFromBackend(baseUrl?: string): Promise<ODataMetadata> {
  const base = (baseUrl || process.env['ODATA_BACKEND_URL'] || DEFAULT_BACKEND_URL).replace(
    /\/+$/,
    '',
  );

  const response = await fetch(`${base}/api/metadata/current`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch metadata: HTTP ${response.status} ${response.statusText}`);
  }

  let body: { metadata?: ODataMetadata | null };
  try {
    body = (await response.json()) as { metadata?: ODataMetadata | null };
  } catch {
    throw new Error(
      `The backend at ${base} did not return JSON. Is "${base}" the OData Visualizer backend?`,
    );
  }

  if (!body.metadata) {
    throw new Error(
      'No metadata available from the backend. Upload a file in the OData Visualizer UI first.',
    );
  }
  return body.metadata;
}

export { parseCSDL };
