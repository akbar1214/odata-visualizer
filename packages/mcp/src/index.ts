#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer, ieee754CompatibleFromEnv } from './server.js';
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
    // The stdio surface has no CLI flags; the shared env convention is the
    // escape hatch from IEEE754 string encoding.
    ieee754Compatible: ieee754CompatibleFromEnv(),
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
