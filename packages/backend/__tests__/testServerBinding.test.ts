import { describe, it, expect } from 'vitest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
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
});
