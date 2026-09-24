import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { metadataStore } from '../src/services/metadataStore.js';

const minimalCSDL = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Test.Models" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Product">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.Int32" Nullable="false" />
        <Property Name="Name" Type="Edm.String" />
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Products" EntityType="Test.Models.Product" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

describe('metadata sharing via the API', () => {
  beforeEach(() => {
    metadataStore.clear();
  });

  it('returns null metadata when nothing has been uploaded', async () => {
    const app = createApp();
    const res = await request(app).get('/api/metadata/current');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.metadata).toBeNull();
    expect(res.body.info).toBeNull();
  });

  it('exposes metadata parsed from raw content', async () => {
    const app = createApp();
    const parse = await request(app).post('/api/parse/content').send({ content: minimalCSDL });
    expect(parse.status).toBe(200);
    expect(parse.body.success).toBe(true);

    const res = await request(app).get('/api/metadata/current');
    expect(res.body.metadata.entities.map((e: { name: string }) => e.name)).toContain('Product');
    expect(res.body.info.sourceType).toBe('content');
  });

  it('records the original file name for uploads', async () => {
    const app = createApp();
    const parse = await request(app)
      .post('/api/parse/file')
      .attach('metadata', Buffer.from(minimalCSDL), 'prodmgmt.xml');
    expect(parse.status).toBe(200);

    const res = await request(app).get('/api/metadata/current');
    expect(res.body.info.sourceName).toBe('prodmgmt.xml');
    expect(res.body.info.sourceType).toBe('file');
    expect(res.body.metadata.entities).toHaveLength(1);
  });

  it('clears the current metadata', async () => {
    const app = createApp();
    await request(app).post('/api/parse/content').send({ content: minimalCSDL });

    const del = await request(app).delete('/api/metadata/current');
    expect(del.status).toBe(200);

    const res = await request(app).get('/api/metadata/current');
    expect(res.body.metadata).toBeNull();
  });

  it('does not store metadata when parsing fails', async () => {
    const app = createApp();
    const parse = await request(app)
      .post('/api/parse/content')
      .send({ content: '<not-valid-csdl><broken>' });
    expect(parse.body.success).toBe(false);

    const res = await request(app).get('/api/metadata/current');
    expect(res.body.metadata).toBeNull();
  });

  it('redacts credentials from the stored URL source', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(minimalCSDL, {
            status: 200,
            headers: { 'Content-Type': 'application/xml' },
          }),
      ),
    );

    const app = createApp();
    const parse = await request(app)
      .post('/api/parse/url')
      .send({ url: 'https://user:hunter2@windchill.example.com/odata/$metadata' });
    expect(parse.status).toBe(200);

    const res = await request(app).get('/api/metadata/current');
    expect(res.body.info.sourceName).toBe('https://user@windchill.example.com/odata/$metadata');
    expect(res.body.info.sourceName).not.toContain('hunter2');
    vi.unstubAllGlobals();
  });

  it('resolves edmx:Reference documents relative to a supplied baseUrl', async () => {
    const main = `<?xml version="1.0"?>
<edmx:Edmx Version="4.01" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Main" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Thing" BaseType="ext.Base">
        <Property Name="Id" Type="Edm.String" />
      </EntityType>
    </Schema>
    <edmx:Reference Uri="shared.xml"><edmx:Include Namespace="Ext" Alias="ext" /></edmx:Reference>
  </edmx:DataServices>
</edmx:Edmx>`;
    const shared = `<?xml version="1.0"?>
<edmx:Edmx Version="4.01" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Ext" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Base"><Key><PropertyRef Name="Id"/></Key>
      <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

    const requested: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        requested.push(String(input));
        return new Response(shared, { status: 200 });
      }),
    );

    const app = createApp();
    const parse = await request(app)
      .post('/api/parse/content')
      .send({ content: main, baseUrl: 'https://windchill.example.com/odata/main.xml' });

    expect(parse.status).toBe(200);
    expect(requested).toEqual(['https://windchill.example.com/odata/shared.xml']);
    expect(parse.body.data.entities.map((e: { qualifiedName: string }) => e.qualifiedName)).toEqual(
      expect.arrayContaining(['Main.Thing', 'Ext.Base']),
    );
    expect(parse.body.data.unresolvedReferences).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('reports unresolved references when no baseUrl is supplied', async () => {
    const main = `<?xml version="1.0"?>
<edmx:Edmx Version="4.01" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Main" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Thing"><Key><PropertyRef Name="Id"/></Key>
      <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
    </Schema>
    <edmx:Reference Uri="shared.xml"><edmx:Include Namespace="Ext" Alias="ext" /></edmx:Reference>
  </edmx:DataServices>
</edmx:Edmx>`;

    const app = createApp();
    const parse = await request(app).post('/api/parse/content').send({ content: main });
    expect(parse.body.data.unresolvedReferences).toEqual(['shared.xml']);
  });
});
