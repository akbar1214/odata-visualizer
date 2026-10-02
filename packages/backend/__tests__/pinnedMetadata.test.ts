import { describe, it, expect, afterEach } from 'vitest';
import { once } from 'node:events';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { parseCSDL } from '@odata-visualizer/shared';
import { createApp } from '../src/app.js';
import { metadataStore } from '../src/services/metadataStore.js';
import { loadPinnedMetadata, metadataFileFromEnv } from '../src/services/pinnedMetadata.js';

const minimalCSDL = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Pinned.Models" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Product">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.Int32" Nullable="false" />
        <Property Name="Name" Type="Edm.String" />
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Products" EntityType="Pinned.Models.Product" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

const PINNED_PARSE_ERROR = 'Metadata is pinned by METADATA_FILE; uploads are disabled.';
const PINNED_CLEAR_ERROR = 'Metadata is pinned by METADATA_FILE; it cannot be cleared.';

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'odata-pinned-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function pinStore(): Promise<void> {
  metadataStore.lockTo(await parseCSDL(minimalCSDL), {
    sourceName: 'pinned.xml',
    sourceType: 'file',
    fileSizeBytes: 42,
  });
}

describe('metadataFileFromEnv', () => {
  it('treats an unset, empty, or whitespace-only value as no pin', () => {
    expect(metadataFileFromEnv({})).toBeUndefined();
    expect(metadataFileFromEnv({ METADATA_FILE: '' })).toBeUndefined();
    expect(metadataFileFromEnv({ METADATA_FILE: '   ' })).toBeUndefined();
    expect(metadataFileFromEnv({ METADATA_FILE: '\t\n' })).toBeUndefined();
  });

  it('trims surrounding whitespace from a path', () => {
    expect(metadataFileFromEnv({ METADATA_FILE: '  /data/metadata.xml  ' })).toBe(
      '/data/metadata.xml',
    );
  });
});

describe('loadPinnedMetadata', () => {
  it('loads a document from disk and reports its basename and size', async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, 'metadata.xml');
      await writeFile(file, minimalCSDL);

      const { metadata, info } = await loadPinnedMetadata(file);

      expect(metadata.entities.map((entity) => entity.name)).toContain('Product');
      // The basename only: the absolute host path must not leak to /api or MCP.
      expect(info.sourceName).toBe('metadata.xml');
      expect(info.sourceName).not.toContain(dir);
      expect(info.sourceType).toBe('file');
      expect(info.fileSizeBytes).toBe(Buffer.byteLength(minimalCSDL, 'utf8'));
    });
  });

  it('rejects a missing file with a message naming the path', async () => {
    await withTempDir(async (dir) => {
      const missing = join(dir, 'no-such-file.xml');
      await expect(loadPinnedMetadata(missing)).rejects.toThrow(/no-such-file\.xml/);
      await expect(loadPinnedMetadata(missing)).rejects.toThrow(/METADATA_FILE/);
    });
  });

  it('rejects a file larger than the upload cap before parsing it', async () => {
    await withTempDir(async (dir) => {
      const huge = join(dir, 'huge.xml');
      await writeFile(huge, minimalCSDL);
      // Sparse, so the 26 MB never hits disk but stat reports the real size.
      await truncate(huge, 26 * 1024 * 1024);

      await expect(loadPinnedMetadata(huge)).rejects.toThrow(/exceed/i);
    });
  });
});

describe('pinned metadata via the API', () => {
  afterEach(() => {
    // The store is a singleton; a leaked pin would silently change every other
    // test file run in this worker.
    metadataStore.unlock();
  });

  it('reports pinned: false when nothing is pinned', async () => {
    const app = createApp();
    const res = await request(app).get('/api/metadata/current');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.pinned).toBe(false);
  });

  it('serves the pinned model with pinned: true', async () => {
    await pinStore();
    const app = createApp();

    const res = await request(app).get('/api/metadata/current');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.pinned).toBe(true);
    expect(res.body.metadata.entities.map((e: { name: string }) => e.name)).toContain('Product');
    expect(res.body.info.sourceName).toBe('pinned.xml');
  });

  it('refuses file uploads with 403 while pinned', async () => {
    await pinStore();
    const app = createApp();

    const res = await request(app)
      .post('/api/parse/file')
      .attach('metadata', Buffer.from(minimalCSDL), 'other.xml');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      success: false,
      error: PINNED_PARSE_ERROR,
      parseTimeMs: 0,
      fileSizeBytes: 0,
    });
  });

  it('refuses before multer validates, so an invalid type still gets the pinned 403', async () => {
    await pinStore();
    const app = createApp();

    // A rejected file type would be a 400 if multer's filter ran first; the
    // pinned guard precedes it, so the refusal is uniform.
    const res = await request(app)
      .post('/api/parse/file')
      .attach('metadata', Buffer.from('not xml'), 'notes.txt');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(PINNED_PARSE_ERROR);
  });

  it('refuses URL parsing with 403 while pinned', async () => {
    await pinStore();
    const app = createApp();

    const res = await request(app)
      .post('/api/parse/url')
      .send({ url: 'https://windchill.example.com/odata/$metadata' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      success: false,
      error: PINNED_PARSE_ERROR,
      parseTimeMs: 0,
      fileSizeBytes: 0,
    });
  });

  it('refuses raw content with 403 while pinned', async () => {
    await pinStore();
    const app = createApp();

    const res = await request(app).post('/api/parse/content').send({ content: minimalCSDL });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      success: false,
      error: PINNED_PARSE_ERROR,
      parseTimeMs: 0,
      fileSizeBytes: 0,
    });
  });

  it('refuses DELETE /current with 403, not 500, while pinned', async () => {
    await pinStore();
    const app = createApp();

    const del = await request(app).delete('/api/metadata/current');
    expect(del.status).toBe(403);
    expect(del.body).toEqual({ success: false, error: PINNED_CLEAR_ERROR });

    // The pin must survive the refused clear.
    const current = await request(app).get('/api/metadata/current');
    expect(current.body.metadata).not.toBeNull();
    expect(current.body.pinned).toBe(true);
  });
});

async function listToolNames(url: string): Promise<string[]> {
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`));
  const client = new Client({ name: 'pinned-metadata-test', version: '1.0.0' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    return tools.map((tool) => tool.name);
  } finally {
    await client.close();
  }
}

describe('MCP while pinned', () => {
  afterEach(() => {
    metadataStore.unlock();
  });

  it('does not offer load_metadata even when MCP_ALLOW_LOAD=1', async () => {
    const previous = process.env['MCP_ALLOW_LOAD'];
    process.env['MCP_ALLOW_LOAD'] = '1';

    const servers: Server[] = [];
    const start = async (): Promise<string> => {
      const started = createApp().listen(0);
      servers.push(started);
      await once(started, 'listening');
      return `http://127.0.0.1:${(started.address() as AddressInfo).port}`;
    };

    try {
      // Positive control: unlocked, the opt-in still registers the tool, so
      // the absence below is the pin's doing rather than the defaults.
      const unlockedUrl = await start();
      expect(await listToolNames(unlockedUrl)).toContain('load_metadata');

      await pinStore();
      const pinnedUrl = await start();
      const tools = await listToolNames(pinnedUrl);
      expect(tools).not.toContain('load_metadata');
      expect(tools).toContain('build_query');
    } finally {
      if (previous === undefined) delete process.env['MCP_ALLOW_LOAD'];
      else process.env['MCP_ALLOW_LOAD'] = previous;
      for (const server of servers) {
        server.closeAllConnections?.();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });
});
