import { describe, it, expect, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { handleToolCall, getMetadata, resetMetadata } from '../src/tools.js';

const minimalCSDL = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Test.Models" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Product">
        <Key>
          <PropertyRef Name="Id" />
        </Key>
        <Property Name="Id" Type="Edm.Int32" Nullable="false" />
        <Property Name="Name" Type="Edm.String" />
        <NavigationProperty Name="Category" Type="Test.Models.Category" />
      </EntityType>
      <EntityType Name="Category">
        <Key>
          <PropertyRef Name="Id" />
        </Key>
        <Property Name="Id" Type="Edm.Int32" Nullable="false" />
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Products" EntityType="Test.Models.Product" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

async function writeFixture(): Promise<string> {
  const { mkdtemp, writeFile } = await import('fs/promises');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const dir = await mkdtemp(join(tmpdir(), 'mcp-test-'));
  const file = join(dir, 'metadata.xml');
  await writeFile(file, minimalCSDL, 'utf-8');
  return file;
}

beforeEach(() => {
  resetMetadata();
});

describe('handleToolCall', () => {
  it('returns isError when source is missing for load_metadata', async () => {
    const result = await handleToolCall('load_metadata', { type: 'file' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('source is required');
  });

  it('returns isError when metadata not loaded', async () => {
    const result = await handleToolCall('list_entities', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No metadata loaded');
  });

  it('loads metadata from a file and lists entities', async () => {
    const file = await writeFixture();
    const load = await handleToolCall('load_metadata', { source: file, type: 'file' });
    expect(load.isError).toBeUndefined();
    expect(load.content[0].text).toContain('Successfully loaded');
    expect(getMetadata()?.entities).toHaveLength(2);

    const list = await handleToolCall('list_entities', {});
    expect(list.isError).toBeUndefined();
    expect(list.content[0].text).toContain('Product');
    expect(list.content[0].text).toContain('Category');
  });

  it('returns entity details with navigation target types', async () => {
    const file = await writeFixture();
    await handleToolCall('load_metadata', { source: file, type: 'file' });

    const details = await handleToolCall('get_entity_details', { entityName: 'product' });
    expect(details.isError).toBeUndefined();
    expect(details.content[0].text).toContain('Entity: Test.Models.Product');
    expect(details.content[0].text).toContain('Category -> Test.Models.Category');
  });

  it('returns isError for unknown entity', async () => {
    const file = await writeFixture();
    await handleToolCall('load_metadata', { source: file, type: 'file' });

    const details = await handleToolCall('get_entity_details', { entityName: 'Nope' });
    expect(details.isError).toBe(true);
    expect(details.content[0].text).toContain('No entity matching');
  });

  it('lists V4 relationships derived from navigation properties', async () => {
    const file = await writeFixture();
    await handleToolCall('load_metadata', { source: file, type: 'file' });

    const rels = await handleToolCall('get_relationships', {});
    expect(rels.isError).toBeUndefined();
    expect(rels.content[0].text).toContain('Product');
    expect(rels.content[0].text).toContain('Category');
  });

  it('returns isError for load failure', async () => {
    const result = await handleToolCall('load_metadata', {
      source: '/nonexistent/path.xml',
      type: 'file',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Error loading metadata');
  });

  it('returns isError for unknown tool', async () => {
    const result = await handleToolCall('nope', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown tool');
  });
});

const windchillFixture = fileURLToPath(
  new URL('../../shared/__tests__/fixtures/windchill-prodmgmt.xml', import.meta.url),
);

async function loadWindchill(): Promise<void> {
  const result = await handleToolCall('load_metadata', {
    source: windchillFixture,
    type: 'file',
  });
  expect(result.isError).toBeUndefined();
}

describe('Windchill-like model tools', () => {
  beforeEach(async () => {
    resetMetadata();
    await loadWindchill();
  });

  it('summarizes actions, functions, enums without dumping every entity', async () => {
    resetMetadata();
    const result = await handleToolCall('load_metadata', {
      source: windchillFixture,
      type: 'file',
    });
    const text = result.content[0].text;
    expect(text).toContain('Actions: 4');
    expect(text).toContain('Functions: 2');
    expect(text).toContain('Enums: 1');
    expect(text).toContain('Entities: 9');
  });

  it('searches entities by name and label', async () => {
    const byName = await handleToolCall('search_entities', { query: 'electrical' });
    expect(byName.content[0].text).toContain('ElectricalPart');

    const byLabel = await handleToolCall('search_entities', { query: 'product structure part' });
    expect(byLabel.content[0].text).toContain('PTC.ProdMgmt.Part');
  });

  it('resolves namespace collisions by qualified name', async () => {
    const ambiguous = await handleToolCall('get_entity_details', { entityName: 'Part' });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.content[0].text).toContain('ambiguous');

    const qualified = await handleToolCall('get_entity_details', {
      entityName: 'PTC.ProdMgmt.Part',
    });
    expect(qualified.isError).toBeUndefined();
    expect(qualified.content[0].text).toContain('PTC.ProdMgmt.Part');
  });

  it('shows inheritance-resolved properties with source types', async () => {
    const details = await handleToolCall('get_entity_details', {
      entityName: 'PTC.ProdMgmt.ElectricalPart',
    });
    const text = details.content[0].text;
    expect(text).toContain('ElectricalPart -> Part -> WindchillEntity');
    expect(text).toContain('ID: Edm.String [KEY, non-nullable] (from WindchillEntity)');
    expect(text).toContain('voltageRating: Edm.Double');
    expect(text).toContain('state: PTC.ProdMgmt.LifeCycleState (enum: INWORK | RELEASED | OBSOLETE)');
    expect(text).toContain('number: PTC.ProdMgmt.PartNumber (type definition of Edm.String)');
    expect(text).toContain('weight: PTC.ProdMgmt.Quantity');
  });

  it('lists entity sets with capabilities and navigation bindings', async () => {
    const sets = await handleToolCall('list_entity_sets', {});
    const text = sets.content[0].text;
    expect(text).toContain('Parts -> PTC.ProdMgmt.Part [create, update, delete, navigate]');
    expect(text).toContain('bindings: Documents->CADDocuments');
  });

  it('lists and describes actions', async () => {
    const list = await handleToolCall('list_actions', { bound: true });
    expect(list.content[0].text).toContain('PTC.ProdMgmt.GetPartStructure [bound]');
    expect(list.content[0].text).not.toContain('CreateParts');

    const details = await handleToolCall('get_action_details', {
      name: 'GetPartStructure',
    });
    const text = details.content[0].text;
    expect(text).toContain('Bound action');
    expect(text).toContain('Return type: Collection(PTC.ProdMgmt.PartStructureItem)');
    expect(text).toContain('Part: PTC.ProdMgmt.Part (binding)');
    expect(text).toContain('Use build_action_invocation');
  });

  it('lists and describes functions', async () => {
    const list = await handleToolCall('list_functions', { bound: false });
    expect(list.content[0].text).toContain('GetWindchillMetaInfo');
    expect(list.content[0].text).not.toContain('GetPartEstimate');

    const details = await handleToolCall('get_function_details', {
      name: 'GetWindchillMetaInfo',
    });
    expect(details.content[0].text).toContain('Import: GetWindchillMetaInfo');
    expect(details.content[0].text).toContain('EntityName: Edm.String');
  });

  it('lists enums and type definitions', async () => {
    const result = await handleToolCall('list_enums', {});
    const text = result.content[0].text;
    expect(text).toContain('PTC.ProdMgmt.LifeCycleState (Edm.String): INWORK=0, RELEASED=1, OBSOLETE=2');
    expect(text).toContain('PTC.ProdMgmt.PartNumber: Edm.String');
  });

  it('builds a typed query URL', async () => {
    const result = await handleToolCall('build_query', {
      entitySet: 'Parts',
      baseUrl: 'https://host/Windchill/servlet/odata/ProdMgmt',
      filters: [
        { property: 'state', operator: 'eq', value: 'RELEASED' },
        { property: 'unitPrice', operator: 'gt', value: '10' },
      ],
      expand: [{ navProperty: 'Documents', select: ['ID'] }],
      orderBy: 'number desc',
      top: 5,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain(
      "https://host/Windchill/servlet/odata/ProdMgmt/Parts?$filter=state eq PTC.ProdMgmt.LifeCycleState'RELEASED' and unitPrice gt 10&$expand=Documents($select=ID)&$orderby=number desc&$top=5",
    );
  });

  it('warns on unknown entity set', async () => {
    const result = await handleToolCall('build_query', { entitySet: 'Partz' });
    expect(result.content[0].text).toContain('not a known entity set');
    expect(result.content[0].text).toContain('Parts');
  });

  it('builds a bound action invocation with typed body', async () => {
    const result = await handleToolCall('build_action_invocation', {
      actionName: 'GetPartStructure',
      entitySet: 'Parts',
      keys: { ID: 'OR:wt.part.WTPart:123' },
      parameters: { ShowSingleLevelReport: 'true' },
      baseUrl: 'https://host/Windchill/servlet/odata/ProdMgmt',
    });
    const text = result.content[0].text;
    expect(text).toContain(
      "POST https://host/Windchill/servlet/odata/ProdMgmt/Parts('OR:wt.part.WTPart:123')/PTC.ProdMgmt.GetPartStructure",
    );
    expect(text).toContain('"ShowSingleLevelReport": true');
    expect(text).toContain('curl -X POST');
  });

  it('requires keys for bound actions', async () => {
    const result = await handleToolCall('build_action_invocation', {
      actionName: 'GetPartStructure',
      entitySet: 'Parts',
      keys: {},
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing key value(s): ID');
  });

  it('builds an unbound function invocation with inline literals', async () => {
    const result = await handleToolCall('build_function_invocation', {
      functionName: 'GetWindchillMetaInfo',
      parameters: { EntityName: 'Part', IncludeAncestorProperty: 'true' },
      baseUrl: 'https://host/Windchill/servlet/odata/ProdMgmt',
    });
    const text = result.content[0].text;
    expect(text).toContain(
      "GET https://host/Windchill/servlet/odata/ProdMgmt/GetWindchillMetaInfo(EntityName='Part',IncludeAncestorProperty=true)",
    );
    expect(text).not.toContain('curl -X GET');
  });

  it('builds a bound function invocation with a numeric inline parameter', async () => {
    const result = await handleToolCall('build_function_invocation', {
      functionName: 'GetPartEstimate',
      entitySet: 'Parts',
      keys: { ID: 'OR:wt.part.WTPart:123' },
      parameters: { Quantity: 12.5 },
    });
    expect(result.content[0].text).toContain(
      "GET <serviceRoot>/Parts('OR:wt.part.WTPart:123')/PTC.ProdMgmt.GetPartEstimate(Quantity=12.5)",
    );
  });
});

