import { describe, it, expect, beforeEach } from 'vitest';
import { parseCSDL } from '@odata-visualizer/shared';
import { createModelStore } from '../src/services/metadataStore.js';

const minimalCSDL = `<?xml version="1.0"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Test" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Product">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.Int32" Nullable="false" />
      </EntityType>
      <EntityContainer Name="C"><EntitySet Name="Products" EntityType="Test.Product" /></EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

async function metadata() {
  return parseCSDL(minimalCSDL);
}

describe('createModelStore', () => {
  let store: ReturnType<typeof createModelStore>;

  beforeEach(() => {
    store = createModelStore();
  });

  it('keeps models isolated per session id', async () => {
    store.save('a', await metadata(), { sourceType: 'file', sourceName: 'a.xml' });
    store.save('b', await metadata(), { sourceType: 'file', sourceName: 'b.xml' });

    expect(store.get('a')?.info.sourceName).toBe('a.xml');
    expect(store.get('b')?.info.sourceName).toBe('b.xml');
  });

  it('tracks the most recent model as current', async () => {
    store.save('a', await metadata(), { sourceName: 'a.xml' });
    store.save('b', await metadata(), { sourceName: 'b.xml' });

    expect(store.current()?.info.sourceName).toBe('b.xml');
  });

  it('falls back to current when no session id is given', async () => {
    store.save('a', await metadata(), { sourceName: 'a.xml' });
    expect(store.get(undefined)?.info.sourceName).toBe('a.xml');
  });

  it('returns null for an unknown session', () => {
    expect(store.get('missing')).toBeNull();
  });

  it('clears one session without touching others', async () => {
    store.save('a', await metadata(), { sourceName: 'a.xml' });
    store.save('b', await metadata(), { sourceName: 'b.xml' });

    store.clear('a');
    expect(store.get('a')).toBeNull();
    expect(store.get('b')?.info.sourceName).toBe('b.xml');
  });

  it('clears everything', async () => {
    store.save('a', await metadata(), { sourceName: 'a.xml' });
    store.save('b', await metadata(), { sourceName: 'b.xml' });

    store.clearAll();
    expect(store.get('a')).toBeNull();
    expect(store.get('b')).toBeNull();
    expect(store.current()).toBeNull();
  });

  it('lists stored models without the metadata payload', async () => {
    store.save('a', await metadata(), { sourceName: 'a.xml' });
    const models = store.list();
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ id: 'a', sourceName: 'a.xml' });
    expect(models[0]).not.toHaveProperty('metadata');
  });

  it('enforces a maximum number of stored models', async () => {
    const limited = createModelStore({ maxModels: 2 });
    limited.save('a', await metadata(), { sourceName: 'a.xml' });
    limited.save('b', await metadata(), { sourceName: 'b.xml' });
    limited.save('c', await metadata(), { sourceName: 'c.xml' });

    expect(limited.list().map((m) => m.id).sort()).toEqual(['b', 'c']);
  });

  it('sanitizes session ids', async () => {
    const m = createModelStore();
    m.save('../../etc/passwd', await metadata(), { sourceName: 'x' });
    expect(m.list().map((entry) => entry.id)).toEqual(['etcpasswd']);
    expect(m.get('../../etc/passwd')).not.toBeNull();
  });
});
