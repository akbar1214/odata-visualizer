import { describe, it, expect } from 'vitest';
import { createToolHandler } from '../src/tools.js';
import { createMetadataStore } from '../src/store.js';

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
      <Function Name="Get#It">
        <Parameter Name="P#1" Type="Edm.String" />
      </Function>
      <EntityContainer Name="Container">
        <EntitySet Name="Th#ings" EntityType="Hostile.Thing" />
        <FunctionImport Name="Imp#ort" Function="Hostile.Get#It" />
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
    const url = emittedUrl(result.content[0].text);
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
    const url = emittedUrl(result.content[0].text);
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
    const text = result.content[0].text;
    expect(text).toContain('https://host/svc/Th%23ings(A%231=<A%231>,B=<B>)/Hostile.Do%23It');
  });

  it('encodes an import name in the unbound details invocation sketch', async () => {
    const handler = await hostileHandler();
    const result = await handler('get_function_details', {
      name: 'Get#It',
      baseUrl: 'https://host/svc',
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('https://host/svc/Imp%23ort');
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
    expect(result.content[0].text).toContain("(A%231='OR:wt.part:1',B='b')/Hostile.Do%23It");
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
    expect(result.content[0].text).toContain('Invalid baseUrl');
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
    expect(result.content[0].text).toContain('Invalid baseUrl');
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
      expect(result.content[0].text).toContain('Invalid baseUrl');
    },
  );

  it.each(invalid)('get_action_details rejects a baseUrl containing a %s', async (baseUrl) => {
    const handler = await hostileHandler();
    const result = await handler('get_action_details', { name: 'Do#It', baseUrl });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid baseUrl');
  });

  it.each(invalid)('get_function_details rejects a baseUrl containing a %s', async (baseUrl) => {
    const handler = await hostileHandler();
    const result = await handler('get_function_details', { name: 'Get#It', baseUrl });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid baseUrl');
  });

  it('still strips a trailing slash from a valid baseUrl', async () => {
    const handler = await hostileHandler();
    const result = await handler('build_query', {
      entitySet: 'Anything',
      baseUrl: 'https://host/svc/',
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('GET https://host/svc/Anything');
    expect(result.content[0].text).not.toContain('https://host/svc//');
  });
});
