import { basename } from 'node:path';
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import type { ODataMetadata } from '@odata-visualizer/shared';
import { parseCSDLFile } from '@odata-visualizer/shared/load';
import { MAX_UPLOAD_BYTES } from './limits.js';
import type { ModelInfo, ModelStore } from './metadataStore.js';

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

/** Read exactly `size` bytes from an already-fstat'ed handle. */
async function readExactly(handle: FileHandle, size: number): Promise<string> {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.toString('utf-8', 0, offset);
}

/**
 * Load the one document the server is pinned to.
 *
 * The file is opened once with `O_NONBLOCK` so a FIFO cannot hang startup, and
 * every check and the whole read run against that one handle: fstat rejects
 * non-regular files and enforces the upload cap, then exactly `stats.size`
 * bytes are read, so a file replaced or grown after the check cannot be
 * over-read. `parseCSDLFile` parses the bytes already read while still
 * resolving relative `edmx:Reference` documents against the file's directory
 * (and refusing ones that escape it).
 */
export async function loadPinnedMetadata(file: string): Promise<PinnedMetadata> {
  let handle: FileHandle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    throw new Error(`METADATA_FILE "${file}" cannot be read: ${errorMessage(error)}`);
  }

  try {
    let stats;
    try {
      stats = await handle.stat();
    } catch (error) {
      throw new Error(`METADATA_FILE "${file}" cannot be read: ${errorMessage(error)}`);
    }
    if (!stats.isFile()) {
      throw new Error(`METADATA_FILE "${file}" is not a regular file`);
    }
    const fileSizeBytes = stats.size;
    if (fileSizeBytes > MAX_UPLOAD_BYTES) {
      throw new Error(
        `METADATA_FILE "${file}" is ${fileSizeBytes} bytes, which exceeds the ` +
          `${MAX_UPLOAD_BYTES}-byte limit`,
      );
    }

    let xmlContent: string;
    try {
      xmlContent = await readExactly(handle, fileSizeBytes);
    } catch (error) {
      throw new Error(`METADATA_FILE "${file}" cannot be read: ${errorMessage(error)}`);
    }

    let metadata: ODataMetadata;
    try {
      metadata = await parseCSDLFile(file, xmlContent);
    } catch (error) {
      throw new Error(`METADATA_FILE "${file}" could not be parsed: ${errorMessage(error)}`);
    }

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
  } finally {
    await handle.close();
  }
}

/**
 * Apply METADATA_FILE to the given store. Returns the pinned model's info, or
 * null when the variable is unset (today's behavior). Failures are re-thrown
 * so the caller can report the cause and refuse to start.
 */
export async function pinFromEnv(
  store: ModelStore,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ModelInfo | null> {
  const file = metadataFileFromEnv(env);
  if (!file) return null;

  const { metadata, info } = await loadPinnedMetadata(file);
  store.lockTo(metadata, info);
  return info;
}
