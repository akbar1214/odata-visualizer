import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { parseCSDL } from '@odata-visualizer/shared';
import { createMcpServer, ieee754CompatibleFromEnv, type McpServerOptions } from '../src/server.js';
import { createStdioServer } from '../src/stdio.js';
import { createMetadataStore, type MetadataAccessors } from '../src/store.js';

const windchillXml = readFileSync(
  fileURLToPath(new URL('../../shared/__tests__/fixtures/windchill-prodmgmt.xml', import.meta.url)),
  'utf-8',
);

/** A minimal action with an Edm.Int64 parameter, for the content-type choice. */
const numericActionCsdl = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Num" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <Action Name="Adjust">
        <Parameter Name="Big" Type="Edm.Int64" />
      </Action>
      <EntityContainer Name="Container" />
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

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

async function connect(accessors: MetadataAccessors, options?: McpServerOptions): Promise<Client> {
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

  it('advertises the key-predicate entitySet form and the literal contract', async () => {
    const client = await connect(createMetadataStore());
    const { tools } = await client.listTools();
    const buildQuery = tools.find((t) => t.name === 'build_query');
    expect(buildQuery).toBeDefined();

    const properties = (
      buildQuery!.inputSchema as { properties?: Record<string, { description?: string }> }
    ).properties;
    // #23 made `Parts('P1')` valid; the schema must not still describe only a
    // bare set name, or a caller will never use the keyed form.
    expect(properties?.['entitySet']?.description).toContain("Parts('P1')");
    // `build_query` types literals from the model for known properties,
    // validates them, and warns (inferring the type) for a property the model
    // does not define; the description must say all three.
    expect(buildQuery!.description).toContain('validated');
    expect(buildQuery!.description).toContain('does not define');
  });

  it('advertises the load_metadata headers argument and its boundaries', async () => {
    const client = await connect(createMetadataStore());
    const { tools } = await client.listTools();
    const loadMetadata = tools.find((t) => t.name === 'load_metadata');
    expect(loadMetadata).toBeDefined();

    const properties = (
      loadMetadata!.inputSchema as {
        properties?: Record<string, { description?: string }>;
      }
    ).properties;
    const description = properties?.['headers']?.description ?? '';
    expect(description).toContain('Authorization');
    expect(description).toContain('validated');
    expect(description).toContain('same-origin');
    expect(description).toContain('never logged');
    expect(description).toContain('type "url"');
  });

  it('still exposes read-only tools when load_metadata is disabled', async () => {
    const store = createMetadataStore();
    store.set(await parseCSDL(windchillXml), { sourceName: 'windchill.xml' });
    const client = await connect(store, { allowLoadMetadata: false });
    const result = await client.callTool({ name: 'list_entities', arguments: { limit: 1 } });
    expect(result.isError).toBeFalsy();
    expect(resultText(result)).toContain('WindchillEntity');
  });

  it('refuses an unrepresentable Int64 body value when ieee754Compatible is disabled', async () => {
    // The option must reach the tool handler through createMcpServer, not only
    // through a direct createToolHandler embedder.
    const store = createMetadataStore();
    store.set(await parseCSDL(numericActionCsdl), {
      sourceName: 'numeric.xml',
      sourceType: 'file',
    });
    const client = await connect(store, { ieee754Compatible: false });

    const result = await client.callTool({
      name: 'build_action_invocation',
      arguments: { actionName: 'Adjust', parameters: { Big: '9007199254740993' } },
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('Invalid Edm.Int64');
    await client.close();
  });
});

/**
 * The HTTP and stdio surfaces share this one read so `MCP_IEEE754_COMPATIBLE`
 * cannot be interpreted two ways. `MCP_ALLOW_LOAD=1` is an explicit opt-in;
 * here the encoding is on by default and the listed false-y spellings turn it
 * off, case-insensitively and ignoring surrounding whitespace.
 */
describe('ieee754CompatibleFromEnv', () => {
  it('treats the false-y spellings as disabled, case-insensitively', () => {
    for (const value of ['0', 'false', 'FALSE', 'False', 'no', 'No', 'off', 'OFF']) {
      expect(
        ieee754CompatibleFromEnv({ MCP_IEEE754_COMPATIBLE: value }),
        `MCP_IEEE754_COMPATIBLE=${value} must disable the encoding`,
      ).toBe(false);
    }
  });

  it('ignores surrounding whitespace around a false-y spelling', () => {
    for (const value of [' 0 ', '\t0\n', ' off ', ' FALSE ']) {
      expect(
        ieee754CompatibleFromEnv({ MCP_IEEE754_COMPATIBLE: value }),
        `MCP_IEEE754_COMPATIBLE=${JSON.stringify(value)} must disable the encoding`,
      ).toBe(false);
    }
  });

  it('enables the encoding for an unset or any other value', () => {
    // Anything else — an empty string, `1`/`true`/`yes`/`on`, or a near-miss
    // like `00` — leaves the default on.
    for (const value of [undefined, '', '1', 'true', 'TRUE', 'yes', 'on', '00']) {
      expect(
        ieee754CompatibleFromEnv(value === undefined ? {} : { MCP_IEEE754_COMPATIBLE: value }),
        `MCP_IEEE754_COMPATIBLE=${JSON.stringify(value)} must enable the encoding`,
      ).toBe(true);
    }
  });
});

/**
 * The stdio entry's wiring lives in `createStdioServer` so a test can drive it
 * without attaching a transport. The environment variable must be observable
 * through this surface: re-inlining the old `!== '0'` read would enable the
 * encoding for `OFF` and fail this test.
 */
describe('createStdioServer', () => {
  it('refuses an inexact Int64 through the stdio wiring when MCP_IEEE754_COMPATIBLE=OFF', async () => {
    const previous = process.env['MCP_IEEE754_COMPATIBLE'];
    process.env['MCP_IEEE754_COMPATIBLE'] = 'OFF';
    try {
      const store = createMetadataStore();
      store.set(await parseCSDL(numericActionCsdl), {
        sourceName: 'numeric.xml',
        sourceType: 'file',
      });
      const server = await createStdioServer(store);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'stdio-env-test', version: '1.0.0' });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        const result = await client.callTool({
          name: 'build_action_invocation',
          arguments: { actionName: 'Adjust', parameters: { Big: '9007199254740993' } },
        });
        expect(result.isError).toBe(true);
        expect(resultText(result)).toContain('Invalid Edm.Int64');
      } finally {
        await client.close();
      }
    } finally {
      if (previous === undefined) delete process.env['MCP_IEEE754_COMPATIBLE'];
      else process.env['MCP_IEEE754_COMPATIBLE'] = previous;
    }
  });
});
