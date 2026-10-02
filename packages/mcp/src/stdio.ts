import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpServer, ieee754CompatibleFromEnv } from './server.js';
import { createMetadataStore, type MetadataAccessors } from './store.js';
import { loadMetadataFromSource } from './metadata-loader.js';

/**
 * Build the server the stdio entry point serves.
 *
 * `load_metadata` is always available on a process the client launched itself,
 * and the IEEE754 flag comes from the shared `MCP_IEEE754_COMPATIBLE`
 * convention. Kept out of `index.ts` so a test can drive this wiring without
 * attaching a stdio transport; the entry's own env read would otherwise only
 * be exercised by a subprocess.
 */
export async function createStdioServer(
  accessors: MetadataAccessors = createMetadataStore(),
): Promise<McpServer> {
  // Optionally preload the metadata uploaded in the OData Visualizer UI.
  if (process.env['ODATA_BACKEND_URL']) {
    try {
      const metadata = await loadMetadataFromSource({
        type: 'server',
        path: process.env['ODATA_BACKEND_URL'],
      });
      accessors.set(metadata, {
        sourceName: process.env['ODATA_BACKEND_URL'],
        sourceType: 'server',
      });
    } catch (error) {
      console.error(
        `Could not preload metadata from ${process.env['ODATA_BACKEND_URL']}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return createMcpServer(accessors, {
    allowLoadMetadata: true,
    ieee754Compatible: ieee754CompatibleFromEnv(),
  });
}
