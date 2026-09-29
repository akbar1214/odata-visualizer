import { createHash } from 'node:crypto';
import type { ODataMetadata } from '@odata-visualizer/shared';
import type { MetadataAccessors } from '@odata-visualizer/mcp/server';

export interface ModelInfo {
  sourceName?: string;
  sourceType?: 'file' | 'url' | 'content' | 'server';
  loadedAt: string;
  fileSizeBytes?: number;
}

export interface StoredModel {
  metadata: ODataMetadata;
  info: ModelInfo;
}

export interface ModelSummary extends ModelInfo {
  id: string;
}

export interface ModelStore {
  /** Store a model for a session id and make it the current one. */
  save(id: string, metadata: ODataMetadata, info?: Partial<ModelInfo>): StoredModel;
  /** Look up a session's model; without an id this is the current model. */
  get(id?: string): StoredModel | null;
  /** The most recently saved model (what MCP uses). */
  current(): StoredModel | null;
  clear(id?: string): void;
  clearAll(): void;
  list(): ModelSummary[];
  /** Summaries for one session only; without an id, the default bucket. */
  listFor(id?: string): ModelSummary[];
  /** MCP accessors backed by the current model. */
  accessors: MetadataAccessors;
}

export interface ModelStoreOptions {
  /** Maximum number of concurrently stored models (default 20). */
  maxModels?: number;
}

const DEFAULT_MODEL_ID = 'default';

/**
 * Session ids come from clients, so they are hashed into a fixed-shape key.
 *
 * The previous implementation stripped disallowed characters, which collapsed
 * `'..'`, `'.'`, `'!!!'` and `''` all onto `default`, and made `'a/b'` collide
 * with `'ab'` — so two unrelated uploads silently clobbered each other.
 */
export function sanitizeModelId(id: string): string {
  const raw = String(id ?? '');
  if (raw.length === 0) return DEFAULT_MODEL_ID;

  // A short, well-behaved id is kept verbatim so the API stays debuggable.
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(raw)) return raw;

  return `h-${createHash('sha256').update(raw).digest('hex').slice(0, 22)}`;
}

/**
 * Holds one parsed model per session id so concurrent browser sessions do not
 * overwrite each other, while still exposing a single "current" model for the
 * MCP server.
 */
export function createModelStore(options: ModelStoreOptions = {}): ModelStore {
  const maxModels = options.maxModels ?? 20;
  const models = new Map<string, StoredModel>();
  let currentId: string | null = null;

  const store: ModelStore = {
    save(id, metadata, info) {
      const key = sanitizeModelId(id);
      if (!models.has(key) && models.size >= maxModels) {
        // Evict the least recently saved entry to stay bounded.
        const oldest = models.keys().next();
        if (!oldest.done) models.delete(oldest.value);
      }
      const model: StoredModel = {
        metadata,
        info: { ...info, loadedAt: info?.loadedAt ?? new Date().toISOString() },
      };
      // Delete first so a re-saved key moves to the end (Map keeps insertion
      // order), otherwise an active session could be evicted while a stale one
      // survives.
      models.delete(key);
      models.set(key, model);
      currentId = key;
      return model;
    },
    get(id) {
      if (id) {
        // An explicit session id never falls back to another session's model.
        // Note this is a convenience boundary, not an authorization control:
        // session ids are supplied by the client, so anyone who knows (or
        // guesses) an id can read that model. Put API_TOKEN in front of the
        // API when that matters.
        return models.get(sanitizeModelId(id)) ?? null;
      }
      return currentId ? (models.get(currentId) ?? null) : null;
    },
    current() {
      return currentId ? (models.get(currentId) ?? null) : null;
    },
    clear(id) {
      if (id) {
        const key = sanitizeModelId(id);
        models.delete(key);
        if (currentId === key) {
          currentId = models.size > 0 ? ([...models.keys()].at(-1) ?? null) : null;
        }
        return;
      }
      // No id: clear the "default" session only, matching where /parse/*
      // stores an upload that arrives without a session header. Callers that
      // really want to wipe everything use clearAll().
      models.delete('default');
      if (currentId === 'default') {
        currentId = models.size > 0 ? ([...models.keys()].at(-1) ?? null) : null;
      }
    },
    clearAll() {
      models.clear();
      currentId = null;
    },
    list() {
      return [...models.entries()].map(([id, model]) => ({ id, ...model.info }));
    },
    listFor(id) {
      const key = sanitizeModelId(id ?? DEFAULT_MODEL_ID);
      const model = models.get(key);
      return model ? [{ id: key, ...model.info }] : [];
    },
    accessors: {
      get: () => store.current(),
      set: (metadata, info) => {
        store.save('default', metadata, info);
      },
      clear: () => store.clearAll(),
    },
  };

  return store;
}

export const metadataStore = createModelStore();
