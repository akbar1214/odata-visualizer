import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { metadataStore } from '../src/services/metadataStore.js';

const minimalCSDL = `<?xml version="1.0"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Test" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Product">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.Int32" Nullable="false" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

describe('API authentication', () => {
  it('allows requests when no token is configured', async () => {
    const app = createApp();
    expect((await request(app).get('/api/health')).status).toBe(200);
  });

  it('rejects API requests without a token when one is configured', async () => {
    const app = createApp({ apiToken: 'sekret' });
    expect((await request(app).post('/api/parse/content').send({ content: minimalCSDL })).status).toBe(401);
    expect((await request(app).get('/api/metadata/current')).status).toBe(401);
  });

  it('accepts a valid bearer token', async () => {
    const app = createApp({ apiToken: 'sekret' });
    const res = await request(app)
      .post('/api/parse/content')
      .set('Authorization', 'Bearer sekret')
      .send({ content: minimalCSDL });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    metadataStore.clearAll();
  });

  it('leaves the health check open', async () => {
    const app = createApp({ apiToken: 'sekret' });
    expect((await request(app).get('/api/health')).status).toBe(200);
  });

  it('rejects a wrong-length token without leaking detail', async () => {
    const app = createApp({ apiToken: 'sekret' });
    const res = await request(app)
      .get('/api/metadata/current')
      .set('Authorization', 'Bearer nope');
    expect(res.status).toBe(401);
    expect(res.text).not.toContain('sekret');
  });
});
