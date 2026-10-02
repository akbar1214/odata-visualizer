#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server.js';
import { createMetadataStore } from './store.js';
import { loadMetadataFromSource } from './metadata-loader.js';

async function main() {
  const store = createMetadataStore();

  // Optionally preload the metadata uploaded in the OData Visualizer UI.
  if (process.env['ODATA_BACKEND_URL']) {
    try {
      const metadata = await loadMetadataFromSource({
        type: 'server',
        path: process.env['ODATA_BACKEND_URL'],
      });
      store.set(metadata, { sourceName: process.env['ODATA_BACKEND_URL'], sourceType: 'server' });
    } catch (error) {
      console.error(
        `Could not preload metadata from ${process.env['ODATA_BACKEND_URL']}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  const server = createMcpServer(store, {
    allowLoadMetadata: true,
    // The stdio surface has no CLI flags; like the HTTP surface, the escape
    // hatch from IEEE754 string encoding is MCP_IEEE754_COMPATIBLE=0.
    ieee754Compatible: process.env['MCP_IEEE754_COMPATIBLE'] !== '0',
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
