import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  hostHeaderValidation,
  localhostHostValidation,
} from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer, type MetadataAccessors } from '@odata-visualizer/mcp/server';

export interface MountMcpOptions {
  /** Route to serve the MCP endpoint on. Defaults to "/mcp". */
  path?: string;
  /** Allow the load_metadata tool over HTTP (arbitrary file reads / SSRF). Defaults to false. */
  allowLoadMetadata?: boolean;
  /** Optional shared secret; when set, requires `Authorization: Bearer <token>`. */
  token?: string;
  /**
   * Hostnames accepted in the Host header. Defaults to localhost only
   * (DNS-rebinding protection). Set to serve /mcp from another hostname.
   */
  allowedHosts?: string[];
}

const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const MAX_SESSIONS = 32;

function tokensMatch(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function resolveGuard(options: MountMcpOptions) {
  const allowedHosts =
    options.allowedHosts && options.allowedHosts.length > 0
      ? options.allowedHosts
      : DEFAULT_ALLOWED_HOSTS;
  const isDefault =
    allowedHosts.length === DEFAULT_ALLOWED_HOSTS.length &&
    allowedHosts.every((h) => DEFAULT_ALLOWED_HOSTS.includes(h));
  return [isDefault ? localhostHostValidation() : hostHeaderValidation(allowedHosts)];
}

/**
 * Mount a Streamable HTTP MCP server on an existing Express app, sharing the
 * given metadata store so uploads are usable without a load_metadata call.
 */
export function mountMcp(
  app: Express,
  accessors: MetadataAccessors,
  options: MountMcpOptions = {},
): void {
  const path = options.path ?? '/mcp';
  const transports: Record<string, StreamableHTTPServerTransport> = {};
  const guards = resolveGuard(options);

  const authorized = (req: Request, res: Response): boolean => {
    if (!options.token) return true;
    const header = req.headers['authorization'];
    const provided =
      typeof header === 'string' && header.startsWith('Bearer ')
        ? header.slice('Bearer '.length)
        : undefined;
    if (tokensMatch(provided, options.token)) return true;
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized' },
      id: null,
    });
    return false;
  };

  const jsonRpcError = (res: Response, status: number, code: number, message: string): void => {
    res.status(status).json({
      jsonrpc: '2.0',
      error: { code, message },
      id: null,
    });
  };

  const serverError = (res: Response): void => {
    if (!res.headersSent) {
      jsonRpcError(res, 500, -32603, 'Internal server error');
    }
  };

  app.post(path, ...guards, async (req: Request, res: Response) => {
    if (!authorized(req, res)) return;
    const sessionId = req.headers['mcp-session-id'];

    try {
      if (typeof sessionId === 'string') {
        const existing = transports[sessionId];
        if (!existing) {
          jsonRpcError(res, 404, -32001, 'Session not found');
          return;
        }
        await existing.handleRequest(req, res, req.body);
        return;
      }

      if (!isInitializeRequest(req.body)) {
        jsonRpcError(res, 400, -32000, 'Bad Request: No valid session ID provided');
        return;
      }

      if (Object.keys(transports).length >= MAX_SESSIONS) {
        jsonRpcError(res, 503, -32000, 'Too many MCP sessions; close an existing session first.');
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = transport;
        },
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) delete transports[sid];
      };

      const server = createMcpServer(accessors, {
        allowLoadMetadata: options.allowLoadMetadata ?? false,
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('Error handling MCP request:', error);
      serverError(res);
    }
  });

  const handleSessionRequest = async (req: Request, res: Response): Promise<void> => {
    if (!authorized(req, res)) return;
    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId !== 'string' || !transports[sessionId]) {
      res.status(404).send('Invalid or missing session ID');
      return;
    }
    try {
      await transports[sessionId].handleRequest(req, res);
    } catch (error) {
      console.error('Error handling MCP session request:', error);
      serverError(res);
    }
  };

  app.get(path, ...guards, handleSessionRequest);
  app.delete(path, ...guards, handleSessionRequest);
}
