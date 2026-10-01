import { describe, it, expect } from 'vitest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { createApp } from '../src/app.js';

/**
 * Guards the loopback binding in `setup.ts`. Supertest dials 127.0.0.1, so
 * every ephemeral test server must bind that address: a server on the
 * unspecified address can be handed a port whose 127.0.0.1 traffic belongs to
 * another process on macOS, and the suite then asserts on that stranger's
 * responses (see setup.ts for the full mechanism and #21 for the failure).
 */
describe('test server binding', () => {
  it('binds an ephemeral server to loopback IPv4', async () => {
    const server = createApp().listen(0);
    await once(server, 'listening');

    const address = server.address() as AddressInfo;
    expect(address.address).toBe('127.0.0.1');
    expect(address.family).toBe('IPv4');

    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("binds supertest's internal server to loopback too", async () => {
    // The server that actually flaked is supertest's own, created inside its
    // constructor — asserting only on `createApp().listen(0)` would miss the
    // path the whole patch exists for. `_server` is internal to supertest; the
    // assertion is deliberately on it, because that is the object whose address
    // the failure depended on.
    const pending = request(createApp()).get('/api/health');
    const address = (
      pending as unknown as { _server: { address(): AddressInfo } }
    )._server.address();

    expect(address.address).toBe('127.0.0.1');
    expect(address.family).toBe('IPv4');
    await pending;
  });
});

/**
 * The patch sits on `net.Server.prototype.listen`, not `http.Server`'s, because
 * `https.Server`, `http2.Server` and a bare `net.Server` inherit the former and
 * would otherwise bypass the invariant this file states. Nothing in the repo
 * binds one today — these assertions are what keep that true.
 *
 * `listen('0')` and `host: ''` are the other two spellings Node coerces to an
 * ephemeral unspecified bind.
 */
describe('the loopback rewrite covers every server type and spelling', () => {
  const bindAndRead = async (server: import('node:net').Server): Promise<AddressInfo> => {
    server.listen(0);
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    server.close();
    return address;
  };

  it('binds a bare net.Server to loopback', async () => {
    const { Server } = await import('node:net');
    const address = await bindAndRead(new Server());

    expect(address.address).toBe('127.0.0.1');
  });

  it('rewrites the string port and the empty host', async () => {
    const { Server } = await import('node:net');

    const byString = new Server();
    byString.listen('0');
    await once(byString, 'listening');
    expect((byString.address() as AddressInfo).address).toBe('127.0.0.1');
    byString.close();

    const byOptions = new Server();
    byOptions.listen({ port: 0, host: '' });
    await once(byOptions, 'listening');
    expect((byOptions.address() as AddressInfo).address).toBe('127.0.0.1');
    byOptions.close();
  });
});

/**
 * Four more spellings reach Node's `options.port = 0` path and were bypassing
 * the rewrite, so the guard's "every spelling" claim was stronger than the code.
 */
describe('the remaining ephemeral spellings', () => {
  it.each([
    ['listen()', (s: import('node:net').Server) => s.listen()],
    ['listen(null)', (s: import('node:net').Server) => s.listen(null as never)],
    ['listen({ port: "0" })', (s: import('node:net').Server) => s.listen({ port: '0' } as never)],
  ])('binds loopback for %s', async (_label, bind) => {
    const { Server } = await import('node:net');
    const server = new Server();
    bind(server);
    await once(server, 'listening');

    expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
    server.close();
  });

  it('binds loopback for listen(cb)', async () => {
    const { Server } = await import('node:net');
    const server = new Server();
    server.listen(() => {});
    await once(server, 'listening');

    expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
    server.close();
  });
});
