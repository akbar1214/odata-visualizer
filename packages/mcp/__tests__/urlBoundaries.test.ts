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
