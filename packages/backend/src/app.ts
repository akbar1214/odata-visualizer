import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { parseRouter } from './routes/parse.js';
import { metadataRouter } from './routes/metadata.js';
import { mountMcp } from './mcp.js';
import { metadataStore } from './services/metadataStore.js';
import { createApiAuth } from './auth.js';
import { isClientError, statusForError } from './services/errors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface CreateAppOptions {
  /** Mount the MCP server at /mcp. Defaults to true. */
  mcp?: boolean;
  /** Bearer token required for /mcp when set. Defaults to MCP_TOKEN. */
  mcpToken?: string;
  /** Allow load_metadata over HTTP. Defaults to MCP_ALLOW_LOAD === "1". */
  allowLoadMetadata?: boolean;
  /** Hostnames allowed in the Host header for /mcp. Defaults to MCP_ALLOWED_HOSTS or localhost. */
  allowedHosts?: string[];
  /** Bearer token required for the REST API. Defaults to API_TOKEN. */
  apiToken?: string;
  /**
   * Origins allowed to read responses cross-origin. Defaults to CORS_ORIGINS,
   * and to none: the bundled frontend is served from this same origin (and
   * proxied by Vite in development), so a wildcard here would only let other
   * websites drive a developer's local backend.
   */
  corsOrigins?: string[];
}

function parseList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : undefined;
}

/** True when the caller is asking for a response that is not ours to send. */
function headersAlreadySent(res: Response): boolean {
  return res.headersSent;
}

export function createApp(options: CreateAppOptions = {}): Express {
  const app: Express = express();
  // Do not advertise the framework; it tells a scanner which advisories apply.
  app.disable('x-powered-by');

  const corsOrigins = options.corsOrigins ?? parseList(process.env['CORS_ORIGINS']);

  if (corsOrigins && corsOrigins.length > 0) {
    app.use(
      cors({
        origin: (origin, callback) => {
          // Same-origin and non-browser callers send no Origin at all.
          if (!origin) return callback(null, true);
          callback(null, corsOrigins.includes(origin));
        },
        credentials: false,
        methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Metadata-Session', 'Accept'],
        maxAge: 600,
      }),
    );
  }

  app.use(express.json({ limit: '10mb' }));
  app.use('/api', createApiAuth(options.apiToken ?? process.env['API_TOKEN']));

  app.use('/api/parse', parseRouter);
  app.use('/api/metadata', metadataRouter);

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  if (options.mcp !== false) {
    mountMcp(app, metadataStore.accessors, {
      token: options.mcpToken ?? process.env['MCP_TOKEN'],
      allowLoadMetadata: options.allowLoadMetadata ?? process.env['MCP_ALLOW_LOAD'] === '1',
      allowedHosts: options.allowedHosts ?? parseList(process.env['MCP_ALLOWED_HOSTS']),
    });
  }

  // Terminal error handler. Without it, Express falls back to finalhandler,
  // which returns an HTML page containing `err.stack` — absolute build paths,
  // dependency versions and source line numbers — and the wrong status code for
  // a multer or body-parser failure.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (headersAlreadySent(res)) return next(err);

    const status = statusForError(err);

    // Only a client error's message is safe to echo; anything else may carry
    // internals, so 5xx bodies stay generic and the detail goes to the log.
    const safeMessage = isClientError(err) ? err.message : 'Internal server error';

    if (status >= 500) {
      // Full detail belongs in the server log, never on the wire.
      console.error('[odata-visualizer] unhandled error:', err);
    }

    res.status(status).json({
      success: false,
      error: safeMessage,
    });
  });

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
