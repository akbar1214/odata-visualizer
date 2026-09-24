import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createModelStore } from '../src/services/metadataStore.js';
import { parseCSDL } from '@odata-visualizer/shared';

const minimalCSDL = `<?xml version="1.0"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices><Schema Namespace="T" xmlns="http://docs.oasis-open.org/odata/ns/edm">
    <EntityType Name="Product"><Key><PropertyRef Name="Id"/></Key><Property Name="Id" Type="Edm.Int32"/></EntityType>
  </Schema></edmx:DataServices></edmx:Edmx>`;

async function metadata() {
  return parseCSDL(minimalCSDL);
}

describe('session handling', () => {
  it('deletes only the default session when no session id is sent', async () => {
    const app = createApp();

    // tab1 uploads its own model, and an upload without a header lands in
    // the "default" session.
    await request(app)
      .post('/api/parse/content')
      .set('X-Metadata-Session', 'tab1')
      .send({ content: minimalCSDL });
    await request(app).post('/api/parse/content').send({ content: minimalCSDL });

    const list = await request(app).get('/api/metadata');
    expect(list.body.models.map((m: { id: string }) => m.id).sort()).toEqual(['default', 'tab1']);

    // No header: must not wipe every session (it used to clear them all).
    await request(app).delete('/api/metadata/current');

    const after = await request(app).get('/api/metadata');
    expect(after.body.models.map((m: { id: string }) => m.id)).toEqual(['tab1']);
  });

  it('deletes only the named session', async () => {
    const app = createApp();
    await request(app)
      .post('/api/parse/content')
      .set('X-Metadata-Session', 'tab1')
      .send({ content: minimalCSDL });
    await request(app)
      .post('/api/parse/content')
      .set('X-Metadata-Session', 'tab2')
      .send({ content: minimalCSDL });

    await request(app).delete('/api/metadata/current').set('X-Metadata-Session', 'tab1');

    const after = await request(app).get('/api/metadata');
    expect(after.body.models.map((m: { id: string }) => m.id)).toEqual(['tab2']);
  });
});

describe('model store eviction', () => {
  it('evicts the least recently saved model (LRU-ish refresh on save)', async () => {
    const store = createModelStore({ maxModels: 2 });
    store.save('a', await metadata(), { sourceName: 'a' });
    store.save('b', await metadata(), { sourceName: 'b' });
    // Re-saving 'a' makes it the most recent, so 'b' is the eviction candidate.
    store.save('a', await metadata(), { sourceName: 'a2' });
    store.save('c', await metadata(), { sourceName: 'c' });

    expect(store.list().map((m) => m.id).sort()).toEqual(['a', 'c']);
    expect(store.get('a')?.info.sourceName).toBe('a2');
  });
});

describe('API authentication paths', () => {
  it('leaves a trailing-slash health check open', async () => {
    const app = createApp({ apiToken: 'tok' });
    expect((await request(app).get('/api/health/')).status).toBe(200);
    expect((await request(app).get('/api/health?probe=1')).status).toBe(200);
  });

  it('still protects other paths with a trailing slash', async () => {
    const app = createApp({ apiToken: 'tok' });
    expect((await request(app).get('/api/metadata/current/')).status).toBe(401);
  });
});
