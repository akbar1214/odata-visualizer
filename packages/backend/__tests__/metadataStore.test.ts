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

    expect(
      limited
        .list()
        .map((m) => m.id)
        .sort(),
    ).toEqual(['b', 'c']);
  });

  it('sanitizes session ids', async () => {
    const m = createModelStore();
    m.save('../../etc/passwd', await metadata(), { sourceName: 'x' });
    const [entry] = m.list();
    // Hashed, so a traversal-shaped id cannot collide with a benign one.
    expect(entry.id).toMatch(/^h-[0-9a-f]{22}$/);
    expect(m.get('../../etc/passwd')).not.toBeNull();
    expect(m.get('h-' + entry.id.slice(2))).not.toBeNull();
  });

  it('keeps distinct ids that previously collapsed onto the same key', async () => {
    const m = createModelStore();
    m.save('..', await metadata(), { sourceName: 'dots' });
    m.save('!!!', await metadata(), { sourceName: 'bangs' });
    m.save('a/b', await metadata(), { sourceName: 'slash' });
    m.save('ab', await metadata(), { sourceName: 'plain' });

    // Stripping disallowed characters used to map all of these onto 'default'
    // (or onto each other), so unrelated uploads silently clobbered one another.
    const ids = m.list().map((entry) => entry.id);
    expect(new Set(ids).size).toBe(4);
    expect(m.get('a/b')?.info.sourceName).toBe('slash');
    expect(m.get('ab')?.info.sourceName).toBe('plain');
  });

  it('scopes listFor to a single session', async () => {
    const m = createModelStore();
    m.save('tab1', await metadata(), { sourceName: 'one' });
    m.save('tab2', await metadata(), { sourceName: 'two' });

    expect(
      m
        .list()
        .map((entry) => entry.id)
        .sort(),
    ).toEqual(['tab1', 'tab2']);
    expect(m.listFor('tab1').map((entry) => entry.id)).toEqual(['tab1']);
    expect(m.listFor('nobody')).toEqual([]);
  });

  it('serves the pinned model from get for any id and from current', async () => {
    const pinned = store.lockTo(await metadata(), { sourceName: 'pinned.xml' });

    expect(store.isLocked()).toBe(true);
    expect(store.get('any-session')).toBe(pinned);
    expect(store.get()).toBe(pinned);
    expect(store.current()).toBe(pinned);
  });

  it('lists only the pinned model under the default bucket', async () => {
    store.lockTo(await metadata(), { sourceName: 'pinned.xml' });

    const expected = [expect.objectContaining({ id: 'default', sourceName: 'pinned.xml' })];
    expect(store.list()).toEqual(expected);
    expect(store.listFor('x')).toEqual(expected);
    expect(store.listFor()).toEqual(expected);
  });

  it('refuses to replace or clear the pinned model', async () => {
    store.save('default', await metadata(), { sourceName: 'default.xml' });
    store.save('a', await metadata(), { sourceName: 'a.xml' });
    store.save('b', await metadata(), { sourceName: 'b.xml' });
    const before = store.current();
    const pinned = store.lockTo(await metadata(), { sourceName: 'pinned.xml' });

    expect(() => store.save('a', pinned.metadata, { sourceName: 'other' })).toThrow(
      'Metadata is pinned and cannot be replaced',
    );
    expect(() => store.clear()).toThrow('Metadata is pinned and cannot be cleared');
    expect(() => store.clear('a')).toThrow('Metadata is pinned and cannot be cleared');
    expect(() => store.clearAll()).toThrow('Metadata is pinned and cannot be cleared');
    expect(() => store.accessors.set(pinned.metadata, { sourceName: 'mcp' })).toThrow(
      'Metadata is pinned and cannot be replaced',
    );
    expect(() => store.accessors.clear()).toThrow('Metadata is pinned and cannot be cleared');

    // The pin survived the refused calls untouched.
    expect(store.current()).toBe(pinned);
    expect(store.get('a')).toBe(pinned);
    expect(store.list()).toHaveLength(1);

    // Unlock so a mutation performed before the throw cannot hide behind the
    // pin: the pre-lock sessions must be exactly as they were.
    store.unlock();
    expect(store.isLocked()).toBe(false);
    expect(store.current()).toBe(before);
    expect(store.list().map((entry) => [entry.id, entry.sourceName])).toEqual([
      ['default', 'default.xml'],
      ['a', 'a.xml'],
      ['b', 'b.xml'],
    ]);
    expect(store.get('pinned')).toBeNull();
  });

  it('replaces the pinned model on a second lockTo', async () => {
    store.lockTo(await metadata(), { sourceName: 'first.xml' });
    const second = store.lockTo(await metadata(), { sourceName: 'second.xml' });

    expect(store.current()).toBe(second);
    expect(store.get('any-session')).toBe(second);
    expect(store.list()).toEqual([
      expect.objectContaining({ id: 'default', sourceName: 'second.xml' }),
    ]);
  });

  it('restores normal save, clear and get semantics after unlock', async () => {
    store.lockTo(await metadata(), { sourceName: 'pinned.xml' });
    store.unlock();

    expect(store.isLocked()).toBe(false);
    store.save('a', await metadata(), { sourceName: 'a.xml' });
    expect(store.get('a')?.info.sourceName).toBe('a.xml');
    expect(store.get('pinned')).toBeNull();
    expect(store.current()?.info.sourceName).toBe('a.xml');

    store.clear('a');
    expect(store.get('a')).toBeNull();
    expect(store.current()).toBeNull();
  });

  it('defaults loadedAt on lockTo when info omits it', async () => {
    const before = new Date().toISOString();
    const pinned = store.lockTo(await metadata(), { sourceName: 'pinned.xml' });
    const after = new Date().toISOString();

    expect(pinned.info.loadedAt >= before && pinned.info.loadedAt <= after).toBe(true);
    expect(store.current()?.info.loadedAt).toBe(pinned.info.loadedAt);
  });
});
