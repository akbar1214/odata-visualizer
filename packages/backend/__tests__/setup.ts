import dns from 'node:dns';
import { Server as NetServer, type ListenOptions } from 'node:net';

/**
 * Bind every ephemeral test HTTP server to 127.0.0.1.
 *
 * `server.listen(0)` with no host binds the unspecified address — on macOS,
 * the dual-stack `::`. macOS will hand that socket a port that is already
 * bound to `127.0.0.1` by another process, and the IPv4-specific socket wins
 * for loopback traffic. The kernel can therefore give a test server a port
 * whose `127.0.0.1` traffic belongs to something else entirely — the OpenCode
 * browser proxy, JetBrains' built-in server, another Vitest worker — and
 * supertest, which dials `127.0.0.1`, receives that stranger's response: a
 * 403 or 407, or a CORS header this app never sends. That is the intermittent
 * backend failure in #21, and it only appears when other processes are
 * holding loopback ports, i.e. under the parallel workspace run.
 *
 * Supertest builds its server with `http.createServer(app)` and calls
 * `listen(0)` itself, so there is no call site to change; patch the one place
 * that chooses the bind address. `listen(0, '127.0.0.1')` never collides with
 * a port already held on 127.0.0.1, 0.0.0.0 or `::` (verified by repetition),
 * and the production entry point already binds 127.0.0.1 explicitly
 * (src/index.ts), so this only brings the tests in line with production.
 */
const PATCH_MARKER = Symbol.for('odata-visualizer.loopback-test-listen');
const originalListen = NetServer.prototype.listen;

/**
 * Rewrite `listen(0)`, `listen(0, cb)`, `listen(0, backlog, cb)` and
 * `listen({ port: 0 }, cb)` to bind loopback. Anything with an explicit host
 * or a non-zero port is left exactly as the caller wrote it.
 */
function withLoopback(args: unknown[]): unknown[] | null {
  const [portOrOptions, second, ...rest] = args;

  // `listen()`, `listen(cb)`, `listen(null)` and `listen(undefined)` all reach
  // Node's `options.port = 0` path — the same ephemeral unspecified bind this
  // function exists to rewrite.
  if (args.length === 0 || portOrOptions === null || portOrOptions === undefined) {
    return [0, '127.0.0.1', ...rest];
  }
  if (typeof portOrOptions === 'function') {
    return [0, '127.0.0.1', portOrOptions, ...rest];
  }

  if (typeof portOrOptions === 'number') {
    if (portOrOptions !== 0 || typeof second === 'string') return null;
    return [0, '127.0.0.1', ...(second === undefined ? [] : [second]), ...rest];
  }

  if (typeof portOrOptions === 'string' && Number(portOrOptions) === 0) {
    if (typeof second === 'string') return null;
    return [0, '127.0.0.1', ...(second === undefined ? [] : [second]), ...rest];
  }

  if (typeof portOrOptions === 'object' && portOrOptions !== null && 'port' in portOrOptions) {
    const options = portOrOptions as ListenOptions;
    // `host: ''` means "unspecified" to Node, so it is as ephemeral as no host.
    if (Number(options.port) !== 0 || (options.host !== undefined && options.host !== '')) {
      return null;
    }
    return [{ ...options, host: '127.0.0.1' }, ...(second === undefined ? [] : [second]), ...rest];
  }

  return null;
}

/**
 * `listen(0, '127.0.0.1')` resolves its host through `dns.lookup`, which is
 * asynchronous even for an IP literal, so `server.address()` would still be
 * null when `listen` returns — and supertest reads `address()` synchronously
 * in its constructor. Answer that one lookup synchronously for the duration
 * of the bind so the port is assigned before `listen` returns. The
 * 'listening' event is still emitted on the next tick, and every other lookup
 * goes to the real resolver untouched.
 */
function bindLoopback(server: NetServer, args: unknown[]): NetServer {
  const realLookup = dns.lookup;

  dns.lookup = function syncLoopbackLookup(
    this: unknown,
    hostname: string,
    options?:
      dns.LookupOptions | dns.LookupOneOptions | dns.LookupAllOptions | ((...a: unknown[]) => void),
    callback?: (...a: unknown[]) => void,
  ): void {
    const cb = (typeof options === 'function' ? options : callback) as
      ((err: NodeJS.ErrnoException | null, ...rest: unknown[]) => void) | undefined;
    if (hostname === '127.0.0.1' && cb) {
      if (
        typeof options === 'object' &&
        options !== null &&
        (options as dns.LookupAllOptions).all
      ) {
        cb(null, [{ address: '127.0.0.1', family: 4 }]);
      } else {
        cb(null, '127.0.0.1', 4);
      }
      return;
    }
    return (realLookup as (...a: unknown[]) => void).apply(this, [hostname, options, callback]);
  } as typeof dns.lookup;

  try {
    return (originalListen as (...a: unknown[]) => NetServer).apply(server, args);
  } finally {
    dns.lookup = realLookup;
  }
}

// Built-in modules are shared between the per-file environments in one worker,
// so the setup file can run against an already-patched prototype.
if (!(NetServer.prototype as unknown as Record<symbol, unknown>)[PATCH_MARKER]) {
  NetServer.prototype.listen = function patchedListen(
    this: NetServer,
    ...args: unknown[]
  ): NetServer {
    const rewritten = withLoopback(args);
    if (!rewritten) {
      return (originalListen as (...a: unknown[]) => NetServer).apply(this, args);
    }
    return bindLoopback(this, rewritten);
  } as unknown as typeof NetServer.prototype.listen;
  (NetServer.prototype as unknown as Record<symbol, unknown>)[PATCH_MARKER] = true;
}
