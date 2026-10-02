import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createApp } from './app.js';
import { metadataStore } from './services/metadataStore.js';
import { loadPinnedMetadata, metadataFileFromEnv } from './services/pinnedMetadata.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = Number(process.env['PORT'] || 3001);

/**
 * Bind to loopback by default.
 *
 * This is a desktop tool whose threat model is "safe on my laptop", and by
 * default it runs unauthenticated with an SSRF-capable `/api/parse/url`. The MCP
 * host check only constrains the `Host` header, which any direct client can set
 * freely, so `listen(port)` on 0.0.0.0 would expose all of that to the network.
 */
const HOST = process.env['HOST'] || '127.0.0.1';

/**
 * With METADATA_FILE set, load the one model before the app (and therefore the
 * listener) exists. A missing or invalid file must fail fast: starting a
 * healthy-looking server that silently serves no model is worse than refusing
 * to start. The pin is read-once; restart the process to reload the file.
 */
const pinnedFile = metadataFileFromEnv();
if (pinnedFile) {
  if (process.env['MCP_ALLOW_LOAD'] === '1') {
    console.warn('⚠️  MCP_ALLOW_LOAD is ignored while METADATA_FILE pins the metadata store.');
  }

  try {
    const { metadata, info } = await loadPinnedMetadata(pinnedFile);
    metadataStore.lockTo(metadata, info);
    console.log(
      `📌 Metadata pinned from ${info.sourceName} (${info.fileSizeBytes} bytes); ` +
        'uploads, URL parsing and clears are disabled.',
    );
  } catch (error) {
    console.error(
      `❌ Failed to load METADATA_FILE "${pinnedFile}":`,
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  }
}

const app = createApp();

app.listen(PORT, HOST, () => {
  console.log(`🚀 OData Visualizer backend running on http://${HOST}:${PORT}`);
  console.log(`🔌 MCP server available at http://${HOST}:${PORT}/mcp`);

  if (HOST === '0.0.0.0' || HOST === '::') {
    console.warn(
      '⚠️  Listening on all interfaces. /api is unauthenticated unless API_TOKEN is set, ' +
        'and /api/parse/url can fetch remote URLs. Set API_TOKEN, or unset HOST to bind to loopback.',
    );
  }

  const frontendDistPath = join(__dirname, '../../frontend/dist');
  if (existsSync(frontendDistPath)) {
    console.log(`📦 Frontend served from ${frontendDistPath}`);
  }
});

export default app;
