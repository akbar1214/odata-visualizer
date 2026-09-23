import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import { metadataStore } from '../src/services/metadataStore.js';

const windchillXml = readFileSync(
  fileURLToPath(
    new URL('../../shared/__tests__/fixtures/windchill-prodmgmt.xml', import.meta.url),
  ),
  'utf-8',
);

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createApp().listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  metadataStore.clear();
});

async function connectClient(): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
  const client = new Client({ name: 'backend-test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

async function uploadWindchill(): Promise<void> {
  const response = await fetch(`${baseUrl}/api/parse/content`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: windchillXml }),
  });
  expect(response.ok).toBe(true);
}

function resultText(result: { content: unknown }): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.map((c) => c.text ?? '').join('\n');
}

describe('MCP over HTTP mounted in the backend', () => {
  it('completes the initialize/tools-list handshake', async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('build_query');
    expect(tools.map((t) => t.name)).toContain('get_metadata_status');
    await client.close();
  });

  it('auto-uses metadata uploaded through the API', async () => {
    await uploadWindchill();
    const client = await connectClient();

    const status = await client.callTool({ name: 'get_metadata_status', arguments: {} });
    expect(resultText(status)).toContain('content');

    const sets = await client.callTool({ name: 'list_entity_sets', arguments: {} });
    expect(resultText(sets)).toContain('Parts -> PTC.ProdMgmt.Part');
    await client.close();
  });

  it('does not expose load_metadata on the HTTP endpoint', async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain('load_metadata');

    const result = await client.callTool({
      name: 'load_metadata',
      arguments: { source: '/etc/hosts', type: 'file' },
    });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it('returns 404 for a request with an unknown session id', async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': 'not-a-real-session',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(404);
  });

  it('returns 404 for SSE/DELETE with an unknown session id', async () => {
    const sse = await fetch(`${baseUrl}/mcp`, { headers: { 'mcp-session-id': 'nope' } });
    expect(sse.status).toBe(404);

    const del = await fetch(`${baseUrl}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': 'nope' },
    });
    expect(del.status).toBe(404);
  });

  it('rejects requests with a non-local Host header', async () => {
    const blocked = await request(createApp())
      .post('/mcp')
      .set('Host', 'evil.example.com')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(blocked.status).toBe(403);
  });

  it('accepts configured allowed hosts', async () => {
    const app = createApp({ allowedHosts: ['windchill.internal'] });
    const allowed = await request(app)
      .post('/mcp')
      .set('Host', 'windchill.internal')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    // Passes host validation, then fails on the missing session (400 not 403).
    expect(allowed.status).toBe(400);
  });

  it('requires the bearer token when MCP_TOKEN is set', async () => {
    const app = createApp({ mcpToken: 's3cret' });
    const server = app.listen(0);
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/mcp`;

    const unauthorized = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
      }),
    });
    expect(unauthorized.status).toBe(401);

    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: 'Bearer s3cret' } },
    });
    const client = new Client({ name: 'token-test', version: '1.0.0' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    await client.close();

    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('reflects metadata cleared through the API', async () => {
    await uploadWindchill();
    await fetch(`${baseUrl}/api/metadata/current`, { method: 'DELETE' });

    const client = await connectClient();
    const result = await client.callTool({ name: 'list_entity_sets', arguments: {} });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('No metadata loaded');
    await client.close();
  });
});
