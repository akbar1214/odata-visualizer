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
  /**
   * Emit Edm.Int64/Edm.Decimal body values as strings under
   * `application/json;IEEE754Compatible=true`. Defaults to true; when false
   * the plain content type is used and a value a JSON number cannot carry
   * exactly is refused.
   */
  ieee754Compatible?: boolean;
  /** Optional shared secret; when set, requires `Authorization: Bearer <token>`. */
  token?: string;
  /**
   * Hostnames accepted in the Host header. Defaults to localhost only
   * (DNS-rebinding protection). Set to serve /mcp from another hostname.
   */
  allowedHosts?: string[];
  /** Maximum concurrent sessions. Defaults to 32. */
  maxSessions?: number;
  /** Close a session after this long without a request. Defaults to 10 minutes. */
  sessionIdleMs?: number;
}

const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const DEFAULT_MAX_SESSIONS = 32;
const DEFAULT_SESSION_IDLE_MS = 10 * 60 * 1000;
const REAP_INTERVAL_MS = 30 * 1000;

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
  const guards = resolveGuard(options);
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const sessionIdleMs = options.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;

  /**
   * A Map, not a plain object: `mcp-session-id` is attacker-controlled, and
   * `transports['__proto__']` returns `Object.prototype` — truthy, so the
   * "unknown session" guard passed and `handleRequest` was then called on it,
   * giving a 500 and a stack trace on every request.
   */
  interface Session {
    transport: StreamableHTTPServerTransport;
    /** Last time this session served a request. */
    lastSeen: number;
  }
  const sessions = new Map<string, Session>();

  /** Sessions being created right now, so the cap cannot be raced past. */
  let pending = 0;

  // Never keep the process alive just to sweep sessions. The sweep interval
  // tracks the TTL so a short TTL (tests, ephemeral clients) is actually swept
  // promptly rather than waiting for the default half-hour cadence.
  const reaper = setInterval(
    () => {
      const cutoff = Date.now() - sessionIdleMs;
      for (const [sessionId, session] of sessions) {
        if (session.lastSeen < cutoff) {
          sessions.delete(sessionId);
          void session.transport.close().catch(() => undefined);
        }
      }
    },
    Math.min(REAP_INTERVAL_MS, Math.max(10, Math.floor(sessionIdleMs / 2))),
  );
  reaper.unref?.();

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
        const existing = sessions.get(sessionId);
        if (!existing) {
          jsonRpcError(res, 404, -32001, 'Session not found');
          return;
        }
        existing.lastSeen = Date.now();
        await existing.transport.handleRequest(req, res, req.body);
        return;
      }

      if (!isInitializeRequest(req.body)) {
        jsonRpcError(res, 400, -32000, 'Bad Request: No valid session ID provided');
        return;
      }

      // `pending` is claimed before the first await so concurrent initializes
      // cannot all observe a free slot and blow past the cap.
      if (sessions.size + pending >= maxSessions) {
        jsonRpcError(res, 503, -32000, 'Too many MCP sessions; close an existing session first.');
        return;
      }
      pending += 1;

      try {
        // Captured here because the SDK clears `transport.sessionId` while it
        // is closing, so reading it back from `onclose` finds nothing and the
        // session would never be released.
        let registeredId: string | undefined;
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            registeredId = sid;
            sessions.set(sid, { transport, lastSeen: Date.now() });
          },
        });
        transport.onclose = () => {
          if (registeredId) sessions.delete(registeredId);
        };

        const server = createMcpServer(accessors, {
          allowLoadMetadata: options.allowLoadMetadata ?? false,
          ieee754Compatible: options.ieee754Compatible,
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } finally {
        pending -= 1;
      }
    } catch (error) {
      console.error('Error handling MCP request:', error);
      serverError(res);
    }
  });

  const handleSessionRequest = async (req: Request, res: Response): Promise<void> => {
    if (!authorized(req, res)) return;
    const sessionId = req.headers['mcp-session-id'];
    const session = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
    if (!session) {
      res.status(404).send('Invalid or missing session ID');
      return;
    }
    try {
      session.lastSeen = Date.now();
      await session.transport.handleRequest(req, res);
    } catch (error) {
      console.error('Error handling MCP session request:', error);
      serverError(res);
    }
  };

  app.get(path, ...guards, handleSessionRequest);
  app.delete(path, ...guards, handleSessionRequest);

  // Exposed so an embedding application (and the test suite) can stop the
  // reaper instead of waiting for process exit.
  app.locals.stopMcpReaper = (): void => clearInterval(reaper);
}
