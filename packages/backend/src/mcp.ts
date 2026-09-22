import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { localhostHostValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer, type MetadataAccessors } from '@odata-visualizer/mcp/server';

export interface MountMcpOptions {
  /** Route to serve the MCP endpoint on. Defaults to "/mcp". */
  path?: string;
  /** Allow the load_metadata tool over HTTP (arbitrary file reads / SSRF). Defaults to false. */
  allowLoadMetadata?: boolean;
  /** Optional shared secret; when set, requires `Authorization: Bearer <token>`. */
  token?: string;
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
  const guards = [localhostHostValidation()];

  const authorized = (req: Request, res: Response): boolean => {
    if (!options.token) return true;
    if (req.headers['authorization'] === `Bearer ${options.token}`) return true;
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized' },
      id: null,
    });
    return false;
  };

  const badRequest = (res: Response, message: string): void => {
    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message },
      id: null,
    });
  };

  const serverError = (res: Response): void => {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  };

  app.post(path, ...guards, async (req: Request, res: Response) => {
    if (!authorized(req, res)) return;
    const sessionId = req.headers['mcp-session-id'];

    try {
      if (typeof sessionId === 'string' && transports[sessionId]) {
        await transports[sessionId].handleRequest(req, res, req.body);
        return;
      }

      if (sessionId || !isInitializeRequest(req.body)) {
        badRequest(res, 'Bad Request: No valid session ID provided');
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

  app.get(path, ...guards, async (req: Request, res: Response) => {
    if (!authorized(req, res)) return;
    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId !== 'string' || !transports[sessionId]) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    try {
      await transports[sessionId].handleRequest(req, res);
    } catch (error) {
      console.error('Error handling MCP SSE request:', error);
      serverError(res);
    }
  });

  app.delete(path, ...guards, async (req: Request, res: Response) => {
    if (!authorized(req, res)) return;
    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId !== 'string' || !transports[sessionId]) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    try {
      await transports[sessionId].handleRequest(req, res);
    } catch (error) {
      console.error('Error handling MCP session termination:', error);
      serverError(res);
    }
  });
}
