#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { handleToolCall } from './tools.js';

const server = new McpServer({
  name: 'odata-visualizer',
  version: '1.0.0',
});

server.registerTool(
  'load_metadata',
  {
    description:
      'Load OData metadata from a file path or URL. This parses the CSDL XML and stores the schema for use by other tools. Call this first before using other tools.',
    inputSchema: {
      source: z
        .string()
        .describe(
          'File path (e.g., "./metadata.xml") or URL (e.g., "https://services.odata.org/V4/OData/OData.svc/$metadata")',
        ),
      type: z
        .enum(['file', 'url'])
        .describe('Type of source: "file" for local file path, "url" for remote URL'),
    },
  },
  async (args) => handleToolCall('load_metadata', args),
);

server.registerTool(
  'list_entities',
  {
    description:
      'List all entities in the loaded OData metadata with their key properties. Use this to discover what entities are available.',
    inputSchema: {},
  },
  async (args) => handleToolCall('list_entities', args),
);

server.registerTool(
  'get_entity_details',
  {
    description:
      'Get the complete schema for a specific entity including all properties, types, keys, and navigation properties. Use this to understand the structure of an entity for building OData queries.',
    inputSchema: {
      entityName: z.string().describe('The name of the entity to get details for'),
    },
  },
  async (args) => handleToolCall('get_entity_details', args),
);

server.registerTool(
  'get_relationships',
  {
    description:
      'List all relationships/associations between entities. Use this to understand how entities are connected for building OData queries with expand.',
    inputSchema: {},
  },
  async (args) => handleToolCall('get_relationships', args),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
