import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { parseCSDL } from '@odata-visualizer/shared';
import { createMcpServer, type McpServerOptions } from '../src/server.js';
import { createMetadataStore, type MetadataAccessors } from '../src/store.js';

const windchillXml = readFileSync(
  fileURLToPath(new URL('../../shared/__tests__/fixtures/windchill-prodmgmt.xml', import.meta.url)),
  'utf-8',
);

const EXPECTED_TOOLS = [
  'build_action_invocation',
  'build_function_invocation',
  'build_query',
  'get_action_details',
  'get_entity_details',
  'get_function_details',
  'get_metadata_status',
  'get_relationships',
  'list_actions',
  'list_entities',
  'list_entity_sets',
  'list_enums',
  'list_functions',
  'load_metadata',
  'search_entities',
];

async function connect(
  accessors: MetadataAccessors,
  options?: McpServerOptions,
): Promise<Client> {
  const server = createMcpServer(accessors, options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function resultText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.map((c) => c.text ?? '').join('\n');
}

describe('createMcpServer', () => {
  it('registers the full tool set', async () => {
    const client = await connect(createMetadataStore());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
  });

  it('reports an empty state via get_metadata_status', async () => {
    const client = await connect(createMetadataStore());
    const result = await client.callTool({ name: 'get_metadata_status', arguments: {} });
    expect(resultText(result)).toContain('No metadata loaded');
  });

  it('auto-uses metadata injected into the shared store', async () => {
    const store = createMetadataStore();
    store.set(await parseCSDL(windchillXml), { sourceName: 'windchill.xml', sourceType: 'file' });
    const client = await connect(store);

    const status = await client.callTool({ name: 'get_metadata_status', arguments: {} });
    expect(resultText(status)).toContain('windchill.xml');

    const sets = await client.callTool({ name: 'list_entity_sets', arguments: {} });
    expect(resultText(sets)).toContain('Parts -> PTC.ProdMgmt.Part');
  });

  it('does not expose load_metadata when it is disabled', async () => {
    const client = await connect(createMetadataStore(), { allowLoadMetadata: false });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain('load_metadata');

    const result = await client.callTool({
      name: 'load_metadata',
      arguments: { source: '/etc/hosts', type: 'file' },
    });
    expect(result.isError).toBe(true);
  });

  it('does not advertise load_metadata when it is disabled', async () => {
    const client = await connect(createMetadataStore(), { allowLoadMetadata: false });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain('load_metadata');
  });

  it('advertises load_metadata when it is enabled', async () => {
    const client = await connect(createMetadataStore());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('load_metadata');
  });

  it('still exposes read-only tools when load_metadata is disabled', async () => {
    const store = createMetadataStore();
    store.set(await parseCSDL(windchillXml), { sourceName: 'windchill.xml' });
    const client = await connect(store, { allowLoadMetadata: false });
    const result = await client.callTool({ name: 'list_entities', arguments: { limit: 1 } });
    expect(result.isError).toBeFalsy();
    expect(resultText(result)).toContain('WindchillEntity');
  });
});
