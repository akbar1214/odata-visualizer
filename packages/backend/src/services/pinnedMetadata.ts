import { basename } from 'node:path';
import { stat } from 'node:fs/promises';
import type { ODataMetadata } from '@odata-visualizer/shared';
import { parseCSDLFile } from '@odata-visualizer/shared/load';
import { MAX_UPLOAD_BYTES } from './limits.js';
import type { ModelInfo } from './metadataStore.js';

/**
 * The file named by `METADATA_FILE`, or undefined when the variable is unset.
 * Surrounding whitespace is ignored and a blank value means "unset", so an
 * empty variable in a container environment does not pin the server to a
 * nonexistent path.
 */
export function metadataFileFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env['METADATA_FILE']?.trim();
  return value ? value : undefined;
}

export interface PinnedMetadata {
  metadata: ODataMetadata;
  info: ModelInfo;
}

/**
 * Load the one document the server is pinned to.
 *
 * The size is checked before the file is read (and therefore before the XML is
 * expanded into an object graph) so an oversized file fails fast instead of
 * exhausting memory. `parseCSDLFile` resolves relative `edmx:Reference`
 * documents against the file's own directory and refuses ones that escape it.
 */
export async function loadPinnedMetadata(file: string): Promise<PinnedMetadata> {
  let fileSizeBytes: number;
  try {
    fileSizeBytes = (await stat(file)).size;
  } catch (error) {
    const cause = error instanceof Error ? error.message : 'unknown error';
    throw new Error(`METADATA_FILE "${file}" cannot be read: ${cause}`);
  }

  if (fileSizeBytes > MAX_UPLOAD_BYTES) {
    throw new Error(
      `METADATA_FILE "${file}" is ${fileSizeBytes} bytes, which exceeds the ` +
        `${MAX_UPLOAD_BYTES}-byte limit`,
    );
  }

  const metadata = await parseCSDLFile(file);

  return {
    metadata,
    info: {
      // Basename only: `info` is echoed by /api/metadata/current and MCP, and
      // the absolute path would leak the host's directory layout.
      sourceName: basename(file),
      sourceType: 'file',
      fileSizeBytes,
      loadedAt: new Date().toISOString(),
    },
  };
}
