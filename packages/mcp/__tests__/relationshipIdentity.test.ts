import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { handleToolCall, resetMetadata } from '../src/tools.js';
import { textOf } from './textOf.js';

/**
 * `B.Part` is declared before `A.Part`, and the only relationship belongs to
 * `A.Part`. The filter used to resolve `r.from.entity` (the short name) with
 * `.find(...)`, which picked `B.Part`, so the relationship for `A.Part` was
 * reported as absent while `B.Part`, which owns nothing, reported it.
 */
const csdl = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="B" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Part">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
    </Schema>
    <Schema Namespace="A" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Part">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="Docs" Type="Collection(A.Doc)" />
      </EntityType>
      <EntityType Name="Doc">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

async function loadFixture(): Promise<void> {
  resetMetadata();
  const dir = await mkdtemp(join(tmpdir(), 'mcp-rel-identity-'));
  const file = join(dir, 'metadata.xml');
  await writeFile(file, csdl, 'utf-8');
  await handleToolCall('load_metadata', { source: file, type: 'file' });
}

describe('get_relationships resolves endpoints by identity', () => {
  it('finds the relationship that belongs to the namespace-qualified entity', async () => {
    await loadFixture();

    const result = await handleToolCall('get_relationships', { entityName: 'A.Part' });

    expect(textOf(result)).toContain('Part_Docs');
    // The endpoint is printed as an identity, so the namespace is visible.
    expect(textOf(result)).toContain('A.Part (*)');
    resetMetadata();
  });

  it('does not attribute the relationship to the same-named entity', async () => {
    await loadFixture();

    const result = await handleToolCall('get_relationships', { entityName: 'B.Part' });

    expect(textOf(result)).toContain('No relationships found for "B.Part"');
    resetMetadata();
  });
});
