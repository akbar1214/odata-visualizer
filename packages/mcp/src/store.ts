import type { ODataMetadata } from '@odata-visualizer/shared';

export type MetadataSourceType = 'file' | 'url' | 'content' | 'server';

/** Provenance for the currently held metadata. */
export interface MetadataInfo {
  sourceName?: string;
  sourceType?: MetadataSourceType;
  loadedAt: string;
  fileSizeBytes?: number;
}

/** Metadata plus its provenance. */
export interface StoredMetadata {
  metadata: ODataMetadata;
  info: MetadataInfo;
}

/**
 * A shared, mutable holder for the "current" metadata. The backend and the
 * MCP tools share one instance so an upload is immediately usable.
 */
export interface MetadataAccessors {
  get(): StoredMetadata | null;
  set(metadata: ODataMetadata, info?: Partial<MetadataInfo>): void;
  clear(): void;
}

export function createMetadataStore(): MetadataAccessors {
  let current: StoredMetadata | null = null;

  return {
    get: () => current,
    set(metadata, info) {
      current = {
        metadata,
        info: {
          ...info,
          loadedAt: info?.loadedAt ?? new Date().toISOString(),
        },
      };
    },
    clear() {
      current = null;
    },
  };
}
