import { createMetadataStore } from '@odata-visualizer/mcp/server';

/**
 * In-memory holder for the metadata uploaded through the UI. The same
 * instance is shared with the MCP server mounted at /mcp, so an upload is
 * immediately available to MCP tools. Memory-only: cleared on restart.
 */
export const metadataStore = createMetadataStore();
