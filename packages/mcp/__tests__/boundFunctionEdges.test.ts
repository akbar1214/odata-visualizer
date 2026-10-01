import { describe, it, expect, beforeEach } from 'vitest';
import { handleToolCall, resetMetadata } from '../src/tools.js';
import { textOf } from './textOf.js';

/**
 * The issue's reproduction plus a navigation property on the result type, so
 * the composed URL has something to `$expand`.
 */
const FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.01" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="A"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
      <EntityType Name="C"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="Related" Type="N.D" /></EntityType>
      <EntityType Name="D"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
      <Function Name="B" IsBound="true">
        <Parameter Name="it" Type="N.A" />
        <ReturnType Type="N.C" />
      </Function>
      <Function Name="WithParam" IsBound="true">
        <Parameter Name="it" Type="N.A" />
        <Parameter Name="limit" Type="Edm.Int32" />
        <ReturnType Type="N.C" />
      </Function>
      <Function Name="Unbound">
        <ReturnType Type="N.C" />
      </Function>
      <EntityContainer Name="C1">
        <EntitySet Name="As" EntityType="N.A" />
        <EntitySet Name="Cs" EntityType="N.C" />
        <FunctionImport Name="B" Function="N.B" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

async function writeFixture(): Promise<string> {
  const { mkdtemp, writeFile } = await import('fs/promises');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const dir = await mkdtemp(join(tmpdir(), 'mcp-bound-fn-'));
  const file = join(dir, 'metadata.xml');
  await writeFile(file, FIXTURE, 'utf-8');
  return file;
}

beforeEach(async () => {
  resetMetadata();
  const file = await writeFixture();
  const load = await handleToolCall('load_metadata', { source: file, type: 'file' });
  expect(load.isError).toBeUndefined();
});

describe('get_relationships reports operation edges', () => {
  it('reports the A -> B() -> C connection for the reproduction metadata', async () => {
    const result = await handleToolCall('get_relationships', { entityName: 'A' });
    const text = textOf(result);

    expect(text).toContain('N.B()');
    expect(text).toContain('N.A -> N.C');
  });

  it('reports operation edges even when there are no navigation relationships', async () => {
    // The reproduction has no navigation properties at all, so
    // `metadata.relationships` is empty; discovery must not depend on it.
    resetMetadata();
    const { mkdtemp, writeFile } = await import('fs/promises');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = await mkdtemp(join(tmpdir(), 'mcp-bound-fn-'));
    const file = join(dir, 'metadata.xml');
    await writeFile(
      file,
      `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.01" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="A"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
      <EntityType Name="C"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
      <Function Name="B" IsBound="true">
        <Parameter Name="it" Type="N.A" />
        <ReturnType Type="N.C" />
      </Function>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`,
      'utf-8',
    );
    await handleToolCall('load_metadata', { source: file, type: 'file' });

    const result = await handleToolCall('get_relationships', {});
    const text = textOf(result);

    expect(text).not.toContain('No relationships found');
    expect(text).toContain('Operation edges:');
    expect(text).toContain('N.B');
  });

  it('exposes the parameters an agent must supply before composing', async () => {
    const result = await handleToolCall('get_relationships', { entityName: 'A' });
    expect(textOf(result)).toContain('requires: limit: Edm.Int32');
  });

  it('does not report an unbound function as an edge', async () => {
    const result = await handleToolCall('get_relationships', {});
    expect(textOf(result)).not.toContain('Unbound');
  });
});

/**
 * A function bound to a base type is invocable on derived instances (OData V4
 * §11.2.2), so `get_relationships` must surface the edge when asked about the
 * derived type. MCP reads the shared traversal graph, so this verifies the
 * fix is inherited rather than re-derived here.
 */
describe('inherited binding types', () => {
  it('reports a base-bound function when asked about the derived type', async () => {
    resetMetadata();
    const { mkdtemp, writeFile } = await import('fs/promises');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = await mkdtemp(join(tmpdir(), 'mcp-bound-fn-inherited-'));
    const file = join(dir, 'metadata.xml');
    await writeFile(
      file,
      `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.01" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Base" />
      <EntityType Name="Derived" BaseType="N.Base" />
      <EntityType Name="C" />
      <Function Name="B" IsBound="true">
        <Parameter Name="it" Type="N.Base" />
        <ReturnType Type="N.C" />
      </Function>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`,
      'utf-8',
    );
    const load = await handleToolCall('load_metadata', { source: file, type: 'file' });
    expect(load.isError).toBeUndefined();

    const result = await handleToolCall('get_relationships', { entityName: 'Derived' });
    const text = textOf(result);

    expect(text).toContain('N.B()');
    expect(text).toContain('N.B(): N.Derived -> N.C');
  });
});

describe('list_functions names the binding type', () => {
  it('shows what a bound function is bound to', async () => {
    const result = await handleToolCall('list_functions', { bound: true });
    expect(textOf(result)).toContain('N.B [bound] on N.A -> N.C');
  });
});

describe('build_function_invocation composes query options', () => {
  function emittedUrl(text: string): string {
    const line = text.split('\n').find((l) => l.startsWith('GET ') || l.startsWith('POST '));
    return (line ?? '').replace(/^(GET|POST) /, '');
  }

  it('appends $select and $expand to a bound invocation', async () => {
    const result = await handleToolCall('build_function_invocation', {
      functionName: 'B',
      entitySet: 'As',
      keys: { Id: '1' },
      select: ['Id'],
      expand: [{ navProperty: 'Related' }],
    });

    expect(emittedUrl(textOf(result))).toBe(
      "<serviceRoot>/As('1')/N.B()?$select=Id&$expand=Related",
    );
  });

  it('keeps the terminal form when no options are supplied (regression)', async () => {
    const result = await handleToolCall('build_function_invocation', {
      functionName: 'B',
      entitySet: 'As',
      keys: { Id: '1' },
    });

    // The terminal form predates this change and must stay byte-for-byte
    // identical: a parameterless function is emitted without parentheses.
    expect(emittedUrl(textOf(result))).toBe("<serviceRoot>/As('1')/N.B");
  });

  it('types filter literals from the function return type', async () => {
    const result = await handleToolCall('build_function_invocation', {
      functionName: 'B',
      entitySet: 'As',
      keys: { Id: '1' },
      filters: [{ property: 'Id', operator: 'eq', value: '1' }],
      top: 2,
    });

    expect(emittedUrl(textOf(result))).toContain("?$filter=Id%20eq%20'1'&$top=2");
  });

  it('warns when an $expand target is not on the return type', async () => {
    const result = await handleToolCall('build_function_invocation', {
      functionName: 'B',
      entitySet: 'As',
      keys: { Id: '1' },
      expand: [{ navProperty: 'Nope' }],
    });

    expect(textOf(result)).toContain('"Nope" is not a navigation property of N.C');
  });

  it('produces an absolute, parseable URL with baseUrl', async () => {
    const result = await handleToolCall('build_function_invocation', {
      functionName: 'B',
      entitySet: 'As',
      keys: { Id: '1' },
      select: ['Id'],
      expand: [{ navProperty: 'Related' }],
      baseUrl: 'https://host/svc',
    });

    const url = new URL(emittedUrl(textOf(result)));
    expect(url.pathname).toBe("/svc/As('1')/N.B()");
    expect(url.searchParams.get('$select')).toBe('Id');
    expect(url.searchParams.get('$expand')).toBe('Related');
  });

  it('composes options on an unbound function too', async () => {
    const result = await handleToolCall('build_function_invocation', {
      functionName: 'Unbound',
      select: ['Id'],
    });

    expect(emittedUrl(textOf(result))).toBe('<serviceRoot>/N.Unbound()?$select=Id');
  });
});
