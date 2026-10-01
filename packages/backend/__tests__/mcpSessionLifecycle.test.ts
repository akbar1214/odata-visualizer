import { describe, it, expect, beforeAll } from 'vitest';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import { metadataStore } from '../src/services/metadataStore.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createApp().listen(0);
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

function rpcHeaders(sessionId: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'mcp-session-id': sessionId,
  };
}

/** A tools/list request against an existing session; 404 means "no such session". */
async function probeSession(url: string, sessionId: string): Promise<number> {
  const response = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: rpcHeaders(sessionId),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  return response.status;
}

async function connect(url: string, name: string): Promise<{
  client: Client;
  transport: StreamableHTTPClientTransport;
}> {
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`));
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

/**
 * `mcp-session-id` is attacker-controlled and was used to index a plain object,
 * so `__proto__` and `constructor` resolved to `Object.prototype` — truthy, so
 * the "not found" guard passed and the code then called a method that does not
 * exist, producing a 500 and a stack trace on every such request.
 */
describe('MCP session id handling', () => {
  for (const sessionId of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    it(`treats "${sessionId}" as an unknown session`, async () => {
      const post = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: rpcHeaders(sessionId),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(post.status).toBe(404);
      expect(await post.text()).not.toMatch(/TypeError|is not a function/);

      const sse = await fetch(`${baseUrl}/mcp`, { headers: { 'mcp-session-id': sessionId } });
      expect(sse.status).toBe(404);

      const del = await fetch(`${baseUrl}/mcp`, {
        method: 'DELETE',
        headers: { 'mcp-session-id': sessionId },
      });
      expect(del.status).toBe(404);
    });
  }
});

/**
 * Sessions were never expired, and the cap was checked with `Object.keys(...)`
 * before the new session was registered, so 32 leaked `initialize` calls denied
 * MCP to the legitimate user until the process restarted.
 */
describe('MCP session lifecycle', () => {
  it('frees a slot when a session is terminated', async () => {
    const app = createApp({ maxSessions: 1 });
    const started = app.listen(0);
    await once(started, 'listening');
    const url = `http://127.0.0.1:${(started.address() as AddressInfo).port}`;

    const first = await connect(url, 'first');

    // The pool holds one session, so a second client must be refused.
    const second = new Client({ name: 'second', version: '1.0.0' });
    const secondTransport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`));
    await expect(second.connect(secondTransport)).rejects.toThrow(/too many|session/i);

    // A client's `close()` only tears down its own side; the session is
    // released by an explicit DELETE.
    await first.transport.terminateSession();

    const third = await connect(url, 'third');
    expect(third.transport.sessionId).toBeTruthy();
    await third.client.close();

    started.closeAllConnections?.();
    await new Promise<void>((resolve) => started.close(() => resolve()));
  });

  it('reclaims a slot from a client that simply disappeared', async () => {
    // `client.close()` does not send a DELETE, so in practice the reaper is the
    // only thing that returns a slot to the pool. The TTL and the poll interval
    // are deliberately far above scheduler jitter: a parallel workspace run can
    // delay a worker for tens of milliseconds, and a 60 ms TTL then reaps the
    // session before the test's own probe reaches it.
    const app = createApp({ maxSessions: 1, sessionIdleMs: 500 });
    const started = app.listen(0);
    await once(started, 'listening');
    const url = `http://127.0.0.1:${(started.address() as AddressInfo).port}`;

    const { client } = await connect(url, 'leaky');
    await client.close();

    let revived: { client: Client; transport: StreamableHTTPClientTransport } | undefined;
    for (let attempt = 0; attempt < 30 && !revived; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        revived = await connect(url, 'revived');
      } catch {
        // still waiting for the reaper
      }
    }
    expect(revived?.transport.sessionId).toBeTruthy();
    await revived?.client.close();

    started.closeAllConnections?.();
    await new Promise<void>((resolve) => started.close(() => resolve()));
  });

  it('reaps a session that has been idle past the TTL', async () => {
    const app = createApp({ sessionIdleMs: 500 });
    const started = app.listen(0);
    await once(started, 'listening');
    const url = `http://127.0.0.1:${(started.address() as AddressInfo).port}`;

    const { client, transport } = await connect(url, 'idle');
    const sessionId = transport.sessionId!;

    expect(await probeSession(url, sessionId)).not.toBe(404);

    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Must have been reaped rather than pinned for the life of the process.
    expect(await probeSession(url, sessionId)).toBe(404);
    await client.close().catch(() => undefined);

    started.closeAllConnections?.();
    await new Promise<void>((resolve) => started.close(() => resolve()));
  });

  it('does not reap a session that is still in use', async () => {
    const app = createApp({ sessionIdleMs: 500 });
    const started = app.listen(0);
    await once(started, 'listening');
    const url = `http://127.0.0.1:${(started.address() as AddressInfo).port}`;

    const { client, transport } = await connect(url, 'busy');
    const sessionId = transport.sessionId!;

    // Keep the session warm for longer than the TTL, probing well inside it.
    for (let i = 0; i < 12; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await probeSession(url, sessionId)).not.toBe(404);
    }

    await client.close();
    started.closeAllConnections?.();
    await new Promise<void>((resolve) => started.close(() => resolve()));
  });

  it('reaps the session id out of the pool once it goes idle', async () => {
    const app = createApp({ maxSessions: 1, sessionIdleMs: 500 });
    const started = app.listen(0);
    await once(started, 'listening');
    const url = `http://127.0.0.1:${(started.address() as AddressInfo).port}`;

    const { transport } = await connect(url, 'unused');
    const sessionId = transport.sessionId!;
    await transport.terminateSession();

    // A brand new session id from a fresh client, then left to go idle.
    const { transport: leaky } = await connect(url, 'leaky');
    expect(await probeSession(url, leaky.sessionId!)).not.toBe(404);

    await new Promise((resolve) => setTimeout(resolve, 1500));

    expect(await probeSession(url, leaky.sessionId!)).toBe(404);
    expect(sessionId).toBeTruthy();

    started.closeAllConnections?.();
    await new Promise<void>((resolve) => started.close(() => resolve()));
  });
});

/**
 * `/mcp` sits outside `/api`, so setting only `API_TOKEN` left the MCP endpoint
 * completely open while the operator reasonably believed the server was
 * authenticated.
 */
describe('MCP authentication', () => {
  const initializeBody = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 't', version: '1' },
    },
  };

  it('inherits the API token when no MCP token is set', async () => {
    const app = createApp({ apiToken: 'shared-secret', mcpToken: undefined });
    const response = await request(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeBody);

    expect(response.status).toBe(401);
  });

  it('accepts the inherited API token', async () => {
    const app = createApp({ apiToken: 'shared-secret', mcpToken: undefined });
    const started = app.listen(0);
    await once(started, 'listening');
    const url = `http://127.0.0.1:${(started.address() as AddressInfo).port}`;

    const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { Authorization: 'Bearer shared-secret' } },
    });
    const client = new Client({ name: 'inherited', version: '1.0.0' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    await client.close();

    started.closeAllConnections?.();
    await new Promise<void>((resolve) => started.close(() => resolve()));
  });

  it('prefers a dedicated MCP token over the API token', async () => {
    const app = createApp({ apiToken: 'api-tok', mcpToken: 'mcp-tok' });
    const response = await request(app)
      .post('/mcp')
      .set('Authorization', 'Bearer api-tok')
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeBody);

    expect(response.status).toBe(401);
  });

  it('still leaves an explicitly tokenless server open', async () => {
    const app = createApp({ apiToken: undefined, mcpToken: undefined });
    const response = await request(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeBody);

    // No token configured anywhere: the host-header guard is the only gate.
    expect(response.status).not.toBe(401);
  });
});
