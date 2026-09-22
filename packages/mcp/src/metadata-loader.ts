import { readFile } from 'fs/promises';
import { parseCSDL, type ODataMetadata } from '@odata-visualizer/shared';

export interface MetadataSource {
  type: 'file' | 'url';
  path: string;
}

export async function loadMetadataFromSource(source: MetadataSource): Promise<ODataMetadata> {
  let xmlContent: string;

  if (source.type === 'file') {
    xmlContent = await readFile(source.path, 'utf-8');
  } else {
    const response = await fetch(source.path, {
      headers: { Accept: 'application/xml, text/xml, application/atomsvc+xml' },
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch metadata: HTTP ${response.status} ${response.statusText}`);
    }

    xmlContent = await response.text();
  }

  return parseCSDL(xmlContent);
}
