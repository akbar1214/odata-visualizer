import express, { type Express } from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { parseRouter } from './routes/parse.js';
import { metadataRouter } from './routes/metadata.js';
import { mountMcp } from './mcp.js';
import { metadataStore } from './services/metadataStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface CreateAppOptions {
  /** Mount the MCP server at /mcp. Defaults to true. */
  mcp?: boolean;
  /** Bearer token required for /mcp when set. Defaults to MCP_TOKEN. */
  mcpToken?: string;
  /** Allow load_metadata over HTTP. Defaults to MCP_ALLOW_LOAD === "1". */
  allowLoadMetadata?: boolean;
}

export function createApp(options: CreateAppOptions = {}): Express {
  const app: Express = express();

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  app.use('/api/parse', parseRouter);
  app.use('/api/metadata', metadataRouter);

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  if (options.mcp !== false) {
    mountMcp(app, metadataStore, {
      token: options.mcpToken ?? process.env['MCP_TOKEN'],
      allowLoadMetadata: options.allowLoadMetadata ?? process.env['MCP_ALLOW_LOAD'] === '1',
    });
  }

  // Serve frontend static files in production
  const frontendDistPath = join(__dirname, '../../frontend/dist');

  if (existsSync(frontendDistPath)) {
    app.use(express.static(frontendDistPath));

    // SPA fallback - serve index.html for all non-API routes
    app.get('*', (_req, res) => {
      res.sendFile(join(frontendDistPath, 'index.html'));
    });
  }

  return app;
}
