import { describe, it, expect } from 'vitest';
import { createToolHandler } from '../src/tools.js';
import { createMetadataStore } from '../src/store.js';
import { textOf } from './textOf.js';

/**
 * A deliberately invalid CSDL document: the names below are not OData
 * identifiers, but the parser accepts them (it is lenient by design), and every
 * one of them is emitted into a URL. The `#` is the dangerous one — it starts a
 * fragment, so everything after it is silently dropped by the client and the
 * request lands on a different resource.
 */
const hostileCSDL = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Hostile" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Thing">
        <Key>
          <PropertyRef Name="A#1" />
          <PropertyRef Name="B" />
        </Key>
        <Property Name="A#1" Type="Edm.String" Nullable="false" />
        <Property Name="B" Type="Edm.String" Nullable="false" />
      </EntityType>
      <Action Name="Do#It" IsBound="true">
        <Parameter Name="it" Type="Hostile.Thing" />
        <Parameter Name="Note" Type="Edm.String" />
      </Action>
      <Function Name="F',=1">
        <Parameter Name="P',=1" Type="Edm.String" />
      </Function>
      <Function Name="Get#It">
        <Parameter Name="P#1" Type="Edm.String" />
      </Function>
      <EntityType Name="One">
        <Key>
          <PropertyRef Name="A#1" />
        </Key>
        <Property Name="A#1" Type="Edm.String" Nullable="false" />
      </EntityType>
      <Action Name="Do(It)" IsBound="true">
        <Parameter Name="it" Type="Hostile.One" />
      </Action>
      <EntityContainer Name="Container">
        <EntitySet Name="Th#ings" EntityType="Hostile.Thing" />
        <EntitySet Name="Ones" EntityType="Hostile.One" />
        <FunctionImport Name="Imp#ort" Function="Hostile.Get#It" />
        <FunctionImport Name="I,=1" Function="Hostile.F',=1" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

async function hostileHandler() {
  const { parseCSDL } = await import('@odata-visualizer/shared');
  const store = createMetadataStore();
  store.set(await parseCSDL(hostileCSDL), { sourceName: 'hostile.xml', sourceType: 'file' });
  return createToolHandler(store, { allowLoadMetadata: false });
}

/** The `<METHOD> <url>` line the tool prints. Actions emit POST, functions GET. */
function emittedUrl(text: string): string {
  const line = text.split('\n').find((l) => l.startsWith('GET ') || l.startsWith('POST '));
  return (line ?? '').replace(/^(GET|POST) /, '');
}

/**
 * Metadata-derived identifiers are data at the URL boundary just like key
 * values are, so they are encoded on emit rather than rejected at parse. The
 * parser tolerates invalid CSDL on purpose (a whole document must not be
 * refused for one odd name), and encoding keeps the URL well-formed: a server
 * percent-decodes before matching, so `Th%23ings` still addresses a set that a
 * lenient server spells `Th#ings`.
 */
describe('metadata-derived identifiers are encoded', () => {
  it('encodes a bound action path: set name, key names and operation name', async () => {
    const handler = await hostileHandler();
    const result = await handler('build_action_invocation', {
      actionName: 'Do#It',
      entitySet: 'Th#ings',
      keys: { 'A#1': 'x', B: 'y' },
      parameters: { Note: 'n' },
      baseUrl: 'https://host/svc',
    });

    expect(result.isError).toBeUndefined();
    const url = emittedUrl(textOf(result));
    expect(url).toContain("Th%23ings(A%231='x',B='y')/Hostile.Do%23It");
    // The raw `#` would have made everything after it a fragment.
    expect(new URL(url).hash).toBe('');
  });

  it('encodes an unbound function import name and its parameter name', async () => {
    const handler = await hostileHandler();
    const result = await handler('build_function_invocation', {
      functionName: 'Get#It',
      parameters: { 'P#1': 'v' },
      baseUrl: 'https://host/svc',
    });

    expect(result.isError).toBeUndefined();
    const url = emittedUrl(textOf(result));
    expect(url).toContain("Imp%23ort(P%231='v')");
    expect(new URL(url).hash).toBe('');
  });

  it('encodes the identifiers in the details invocation sketch', async () => {
    const handler = await hostileHandler();
    const result = await handler('get_action_details', {
      name: 'Do#It',
      baseUrl: 'https://host/svc',
    });

    expect(result.isError).toBeUndefined();
    const text = textOf(result);
    expect(text).toContain('https://host/svc/Th%23ings(A%231=<A%231>,B=<B>)/Hostile.Do%23It');
  });

  it('encodes an import name in the unbound details invocation sketch', async () => {
    const handler = await hostileHandler();
    const result = await handler('get_function_details', {
      name: 'Get#It',
      baseUrl: 'https://host/svc',
    });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('https://host/svc/Imp%23ort');
  });

  it('still emits a normal path unchanged, so readability is not lost', async () => {
    const handler = await hostileHandler();
    const result = await handler('build_action_invocation', {
      actionName: 'Do#It',
      entitySet: 'Th#ings',
      keys: { 'A#1': 'OR:wt.part:1', B: 'b' },
      parameters: { Note: 'n' },
      baseUrl: 'https://host/svc',
    });

    // Colons and dots are legal raw in a path segment and stay readable.
    expect(textOf(result)).toContain("(A%231='OR:wt.part:1',B='b')/Hostile.Do%23It");
  });
});

/**
 * `+` and `;` are RFC-legal raw in a path and curl accepts both, but their
 * meaning is not stable across stacks: servlet containers treat `;` as a
 * path-parameter delimiter (`/Parts;jsessionid=…`), and legacy decoders turn
 * `+` into a space outside the query string. Path values are data, and a server
 * percent-decodes before matching, so encoding both is the safe side of the
 * trade. The query side has the opposite policy for `;` because nested
 * `$expand` uses it as a separator — there it is structure, not data.
 */
describe('path values encode + and ;', () => {
  it('encodes + and ; in an inline parameter value', async () => {
    const handler = await hostileHandler();
    const result = await handler('build_function_invocation', {
      functionName: 'Get#It',
      parameters: { 'P#1': 'a+b;c' },
      baseUrl: 'https://host/svc',
    });

    const url = emittedUrl(textOf(result));
    expect(url).toContain("P%231='a%2Bb%3Bc'");
    expect(decodeURIComponent(url)).toContain("'a+b;c'");
  });

  it('encodes + and ; in a key value', async () => {
    const handler = await hostileHandler();
    const result = await handler('build_action_invocation', {
      actionName: 'Do#It',
      entitySet: 'Th#ings',
      keys: { 'A#1': 'x+y;z', B: 'b' },
      parameters: { Note: 'n' },
      baseUrl: 'https://host/svc',
    });

    const url = emittedUrl(textOf(result));
    expect(url).toContain("(A%231='x%2By%3Bz',B='b')");
    expect(decodeURIComponent(url)).toContain("'x+y;z'");
  });
});

/**
 * Every MCP tool that splices a caller-supplied `baseUrl` in front of a path
 * must validate it: a space makes curl reject the whole URL, a `#` turns the
 * generated path into a fragment, and a `?` folds it into a query string.
 */
describe('baseUrl is validated at every MCP splice point', () => {
  const invalid: Array<[string, string]> = [
    ['https://host/a b', 'space'],
    ['https://host/svc#frag', 'fragment'],
    ['https://host/svc?x=1', 'query'],
  ];

  it.each(invalid)('build_query rejects a baseUrl containing a %s', async (baseUrl) => {
    const handler = await hostileHandler();
    const result = await handler('build_query', { entitySet: 'Anything', baseUrl });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Invalid baseUrl');
  });

  it.each(invalid)('build_action_invocation rejects a baseUrl containing a %s', async (baseUrl) => {
    const handler = await hostileHandler();
    const result = await handler('build_action_invocation', {
      actionName: 'Do#It',
      entitySet: 'Th#ings',
      keys: { 'A#1': 'x', B: 'y' },
      baseUrl,
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Invalid baseUrl');
  });

  it.each(invalid)(
    'build_function_invocation rejects a baseUrl containing a %s',
    async (baseUrl) => {
      const handler = await hostileHandler();
      const result = await handler('build_function_invocation', {
        functionName: 'Get#It',
        baseUrl,
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('Invalid baseUrl');
    },
  );

  it.each(invalid)('get_action_details rejects a baseUrl containing a %s', async (baseUrl) => {
    const handler = await hostileHandler();
    const result = await handler('get_action_details', { name: 'Do#It', baseUrl });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Invalid baseUrl');
  });

  it.each(invalid)('get_function_details rejects a baseUrl containing a %s', async (baseUrl) => {
    const handler = await hostileHandler();
    const result = await handler('get_function_details', { name: 'Get#It', baseUrl });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Invalid baseUrl');
  });

  it('still strips a trailing slash from a valid baseUrl', async () => {
    const handler = await hostileHandler();
    const result = await handler('build_query', {
      entitySet: 'Anything',
      baseUrl: 'https://host/svc/',
    });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('GET https://host/svc/Anything');
    expect(textOf(result)).not.toContain('https://host/svc//');
  });
});

/**
 * `IDENTIFIER_UNSAFE` adds `( ) , = '` on top of the path set, because those are
 * OData *structure* in an identifier position — and `IDENTIFIER_UNSAFE =
 * PATH_UNSAFE` survived the whole suite, since no fixture name contained any of
 * them. The single-key branch of the invocation sketch was unexercised for the
 * same reason: the other fixture type has two keys, so the ternary always took
 * the compound branch.
 */
describe('the full identifier set and the single-key branch', () => {
  it('encodes OData-structure characters in an operation name', async () => {
    const handler = await hostileHandler();
    const result = await handler('get_action_details', {
      name: 'Do(It)',
      baseUrl: 'https://host/svc',
    });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('/Hostile.Do%28It%29');
  });

  it('encodes the key name twice in the single-key branch', async () => {
    const handler = await hostileHandler();
    const result = await handler('get_action_details', {
      name: 'Do(It)',
      baseUrl: 'https://host/svc',
    });

    // The single-key branch spells the name on both sides of the `=`; both must
    // be encoded, and the raw `#` would start a fragment.
    const line = textOf(result).split('\n').find((l) => l.includes('/Ones('))!;
    expect(line.trim()).toBe('https://host/svc/Ones(A%231=<A%231>)/Hostile.Do%28It%29');
    expect(new URL(line.trim()).hash).toBe('');
  });
});

/**
 * The fourth `baseUrl` splice, in `loadFromBackend`. It was reached by
 * `load_metadata { type: 'server' }`, and a `#` there truncated the request to
 * the path before it while the error message named a URL that was never
 * requested. Validation throws before any fetch, so this needs no network.
 */
describe('the backend source is validated like any other base URL', () => {
  it('refuses a server source whose base URL carries a fragment', async () => {
    const { handleToolCall } = await import('../src/tools.js');
    const result = await handleToolCall('load_metadata', {
      source: 'http://127.0.0.1:9/svc#frag',
      type: 'server',
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Invalid baseUrl');
  });
});

/**
 * `'`, `,` and `=` are the rest of `IDENTIFIER_UNSAFE`'s additions. Each could
 * be dropped individually with both suites still green — only the four
 * characters together were pinned — so an operation name and a parameter name
 * carrying all three are exercised here.
 */
describe('the quote, comma and equals in an identifier position', () => {
  it('encodes them in a function import and a parameter name', async () => {
    const handler = await hostileHandler();
    const result = await handler('build_function_invocation', {
      functionName: "F',=1",
      parameters: { "P',=1": 'v' },
      baseUrl: 'https://host/svc',
    });

    expect(result.isError).toBeUndefined();
    const url = emittedUrl(textOf(result));
    expect(url).toContain('I%2C%3D1');
    expect(url).toContain('P%27%2C%3D1');
  });
});
