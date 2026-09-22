import { describe, it, expect } from 'vitest';
import type { ODataMetadata } from '@odata-visualizer/shared';
import { createMetadataStore } from '../src/store.js';

const emptyMetadata: ODataMetadata = {
  entities: [],
  relationships: [],
  entityContainers: [],
  functionImports: [],
  actionImports: [],
  actions: [],
  functions: [],
  enumTypes: [],
  typeDefinitions: [],
};

describe('createMetadataStore', () => {
  it('starts empty', () => {
    const store = createMetadataStore();
    expect(store.get()).toBeNull();
  });

  it('stores metadata and stamps loadedAt', () => {
    const store = createMetadataStore();
    store.set(emptyMetadata, { sourceName: 'a.xml', sourceType: 'file' });

    const stored = store.get();
    expect(stored?.metadata).toBe(emptyMetadata);
    expect(stored?.info.sourceName).toBe('a.xml');
    expect(stored?.info.sourceType).toBe('file');
    expect(stored?.info.loadedAt).toBeTruthy();
    expect(Number.isNaN(Date.parse(stored!.info.loadedAt))).toBe(false);
  });

  it('overwrites the previous metadata', () => {
    const store = createMetadataStore();
    const second = { ...emptyMetadata, version: '4.01' };
    store.set(emptyMetadata, { sourceName: 'a.xml' });
    store.set(second, { sourceName: 'b.xml' });

    expect(store.get()?.metadata).toBe(second);
    expect(store.get()?.info.sourceName).toBe('b.xml');
  });

  it('clears metadata', () => {
    const store = createMetadataStore();
    store.set(emptyMetadata, { sourceName: 'a.xml' });
    store.clear();
    expect(store.get()).toBeNull();
  });

  it('lets the caller supply loadedAt', () => {
    const store = createMetadataStore();
    store.set(emptyMetadata, { loadedAt: '2024-01-01T00:00:00.000Z' });
    expect(store.get()?.info.loadedAt).toBe('2024-01-01T00:00:00.000Z');
  });
});
