import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  createToolHandler,
  handleToolCall,
  getMetadata,
  resetMetadata,
} from '../src/tools.js';
import { createMetadataStore } from '../src/store.js';

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

describe('createToolHandler', () => {
  it('errors with no metadata when the injected store is empty', async () => {
    const handler = createToolHandler(createMetadataStore());
    const result = await handler('list_entities', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No metadata loaded');
  });

  it('reads metadata injected into the store without load_metadata', async () => {
    const { parseCSDL } = await import('@odata-visualizer/shared');
    const { readFileSync } = await import('node:fs');
    const xml = readFileSync(windchillFixture, 'utf-8');

    const store = createMetadataStore();
    store.set(await parseCSDL(xml), { sourceName: 'upload.xml', sourceType: 'file' });
    const handler = createToolHandler(store);

    const result = await handler('list_entity_sets', {});
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Parts -> PTC.ProdMgmt.Part');
  });

  it('reports the loaded source via get_metadata_status', async () => {
    const { parseCSDL } = await import('@odata-visualizer/shared');
    const { readFileSync } = await import('node:fs');
    const xml = readFileSync(windchillFixture, 'utf-8');

    const store = createMetadataStore();
    store.set(await parseCSDL(xml), { sourceName: 'windchill.xml', sourceType: 'file' });
    const result = await createToolHandler(store)('get_metadata_status', {});

    const text = result.content[0].text;
    expect(text).toContain('windchill.xml');
    expect(text).toContain('Entities: 9');
    expect(text).toContain('Entity sets: 4');
  });

  it('surfaces unresolved references in get_metadata_status', async () => {
    const { parseCSDL } = await import('@odata-visualizer/shared');
    const withReference = `<?xml version="1.0"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="M" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="A"><Key><PropertyRef Name="Id"/></Key><Property Name="Id" Type="Edm.String"/></EntityType>
    </Schema>
    <edmx:Reference Uri="missing.xml"><edmx:Include Namespace="X" Alias="x" /></edmx:Reference>
  </edmx:DataServices>
</edmx:Edmx>`;

    const store = createMetadataStore();
    store.set(await parseCSDL(withReference), { sourceName: 'partial.xml' });
    const result = await createToolHandler(store)('get_metadata_status', {});
    expect(result.content[0].text).toContain('Unresolved references: missing.xml');
  });
});

const edgeCaseCSDL = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Edge" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EnumType Name="Color" UnderlyingType="Edm.String">
        <Member Name="RED" Value="0" />
        <Member Name="BLUE" Value="1" />
      </EnumType>
      <EntityType Name="Thing">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <Property Name="Tags" Type="Collection(Edge.Color)" />
        <Property Name="Labels" Type="Collection(Edge.Code)" />
        <NavigationProperty Name="Owner" Type="Edge.Thing" />
      </EntityType>
      <TypeDefinition Name="Code" UnderlyingType="Edm.String" />
      <Action Name="Touch" IsBound="true">
        <Parameter Name="bindingParameter" Type="Edge.Ghost" />
      </Action>
      <Action Name="Reset">
        <Parameter Name="Scope" Type="Edm.String" Nullable="true" />
      </Action>
      <Function Name="Lookup">
        <Parameter Name="Term" Type="Edm.String" />
        <ReturnType Type="Edm.String" />
      </Function>
      <EntityContainer Name="Container">
        <EntitySet Name="Things" EntityType="Edge.Thing" />
        <EntitySet Name="Ghosts" EntityType="Edge.Ghost" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

async function windchillHandler() {
  const { parseCSDL } = await import('@odata-visualizer/shared');
  const { readFileSync } = await import('node:fs');
  const store = createMetadataStore();
  store.set(await parseCSDL(readFileSync(windchillFixture, 'utf-8')), {
    sourceName: 'windchill.xml',
    sourceType: 'file',
  });
  return createToolHandler(store);
}

async function edgeCaseHandler() {
  const { parseCSDL } = await import('@odata-visualizer/shared');
  const store = createMetadataStore();
  store.set(await parseCSDL(edgeCaseCSDL), { sourceName: 'edge.xml', sourceType: 'file' });
  return createToolHandler(store);
}

describe('invocation builders', () => {
  it('excludes the binding parameter from an action request body', async () => {
    const handler = await windchillHandler();
    const result = await handler('build_action_invocation', {
      actionName: 'GetPartStructure',
      entitySet: 'Parts',
      keys: { ID: 'OR:wt.part.WTPart:1' },
      parameters: { Part: 'should-not-appear', ShowSingleLevelReport: 'true' },
    });

    const text = result.content[0].text;
    expect(text).toContain('"ShowSingleLevelReport": true');
    expect(text).not.toContain('should-not-appear');
  });

  it('excludes the binding parameter from function inline parameters', async () => {
    const handler = await windchillHandler();
    const result = await handler('build_function_invocation', {
      functionName: 'GetPartEstimate',
      entitySet: 'Parts',
      keys: { ID: 'OR:wt.part.WTPart:1' },
      parameters: { Part: 'should-not-appear', Quantity: '3' },
    });

    const text = result.content[0].text;
    expect(text).toContain(
      "GET <serviceRoot>/Parts('OR:wt.part.WTPart:1')/PTC.ProdMgmt.GetPartEstimate(Quantity=3)",
    );
    expect(text).not.toContain('should-not-appear');
  });

  it('maps differently-cased parameter names onto the declared parameter', async () => {
    const handler = await windchillHandler();
    const result = await handler('build_action_invocation', {
      actionName: 'GetPartStructure',
      entitySet: 'Parts',
      keys: { ID: 'OR:wt.part.WTPart:1' },
      parameters: { showsinglelevelreport: 'true' },
    });

    const text = result.content[0].text;
    expect(text).toContain('"ShowSingleLevelReport": true');
  });

  it('rejects parameters that are not declared by the operation', async () => {
    const handler = await windchillHandler();
    const result = await handler('build_action_invocation', {
      actionName: 'GetPartStructure',
      entitySet: 'Parts',
      keys: { ID: 'OR:wt.part.WTPart:1' },
      parameters: { Bogus: 1 },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown parameter "Bogus"');
    expect(result.content[0].text).toContain('ShowSingleLevelReport');
  });

  it('rejects a non-boolean value for a boolean parameter', async () => {
    const handler = await windchillHandler();
    const result = await handler('build_action_invocation', {
      actionName: 'GetPartStructure',
      entitySet: 'Parts',
      keys: { ID: 'OR:wt.part.WTPart:1' },
      parameters: { ShowSingleLevelReport: 'yes' },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid Edm.Boolean');
  });

  it('rejects a non-numeric value for a numeric function parameter', async () => {
    const handler = await windchillHandler();
    const result = await handler('build_function_invocation', {
      functionName: 'GetPartEstimate',
      entitySet: 'Parts',
      keys: { ID: 'OR:wt.part.WTPart:1' },
      parameters: { Quantity: 'abc' },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid Edm.Double');
  });

  it('emits a null literal for null function parameters', async () => {
    const handler = await windchillHandler();
    const result = await handler('build_function_invocation', {
      functionName: 'GetWindchillMetaInfo',
      parameters: { EntityName: null, IncludeAncestorProperty: 'true' },
    });

    expect(result.content[0].text).toContain(
      "GET <serviceRoot>/GetWindchillMetaInfo(EntityName=null,IncludeAncestorProperty=true)",
    );
  });

  it('shell-escapes single quotes in the generated curl example', async () => {
    const handler = await windchillHandler();
    const result = await handler('build_action_invocation', {
      actionName: 'CreateParts',
      parameters: { PartNames: ["O'Brien"] },
    });

    const text = result.content[0].text;
    expect(text).toContain("O'\\''Brien");
  });

  it('does not emit a Content-Type header for GET function invocations', async () => {
    const handler = await windchillHandler();
    const result = await handler('build_function_invocation', {
      functionName: 'GetWindchillMetaInfo',
      parameters: { EntityName: 'Part' },
    });

    expect(result.content[0].text).not.toContain('Content-Type');
  });

  it('addresses an unbound action with no import by its qualified name', async () => {
    const handler = await edgeCaseHandler();
    const result = await handler('build_action_invocation', {
      actionName: 'Reset',
      parameters: { Scope: 'all' },
    });
    expect(result.content[0].text).toContain('POST <serviceRoot>/Edge.Reset');
  });

  it('addresses an unbound function with no import by its qualified name', async () => {
    const handler = await edgeCaseHandler();
    const result = await handler('build_function_invocation', {
      functionName: 'Lookup',
      parameters: { Term: 'x' },
    });
    expect(result.content[0].text).toContain("GET <serviceRoot>/Edge.Lookup(Term='x')");
  });
});

describe('build_query diagnostics', () => {
  it('warns about unknown $select properties', async () => {
    const handler = await windchillHandler();
    const result = await handler('build_query', {
      entitySet: 'Parts',
      select: ['ID', 'Nmae'],
    });
    const text = result.content[0].text;
    expect(text).toContain('GET /Parts?$select=ID,Nmae');
    expect(text).toContain('"Nmae" is not a property of PTC.ProdMgmt.Part');
  });

  it('warns about unknown $orderby fields', async () => {
    const handler = await windchillHandler();
    const result = await handler('build_query', {
      entitySet: 'Parts',
      orderBy: 'nmae desc',
    });
    expect(result.content[0].text).toContain('"nmae" is not a property of PTC.ProdMgmt.Part');
  });

  it('warns about unknown $filter properties', async () => {
    const handler = await windchillHandler();
    const result = await handler('build_query', {
      entitySet: 'Parts',
      filters: [{ property: 'nope', operator: 'eq', value: '1' }],
    });
    expect(result.content[0].text).toContain('"nope" is not a property of PTC.ProdMgmt.Part');
  });

  it('warns about unknown $expand navigation properties', async () => {
    const handler = await windchillHandler();
    const result = await handler('build_query', {
      entitySet: 'Parts',
      expand: [{ navProperty: 'NoSuchNav' }],
    });
    expect(result.content[0].text).toContain(
      '"NoSuchNav" is not a navigation property of PTC.ProdMgmt.Part',
    );
  });

  it('reports the path of a nested unknown expand', async () => {
    const handler = await windchillHandler();
    const result = await handler('build_query', {
      entitySet: 'Parts',
      expand: [
        {
          navProperty: 'Documents',
          expand: [{ navProperty: 'Missing' }],
        },
      ],
    });
    expect(result.content[0].text).toContain('Documents/Missing');
  });

  it('does not warn for valid properties', async () => {
    const handler = await windchillHandler();
    const result = await handler('build_query', {
      entitySet: 'Parts',
      select: ['ID', 'number'],
      orderBy: 'number desc',
      filters: [{ property: 'state', operator: 'eq', value: 'RELEASED' }],
      expand: [{ navProperty: 'Documents', select: ['ID'] }],
    });
    expect(result.content[0].text).not.toContain('not a property');
    expect(result.content[0].text).not.toContain('not a navigation property');
  });

  it('builds a groupby/aggregate query', async () => {
    const handler = await windchillHandler();
    const result = await handler('build_query', {
      entitySet: 'Parts',
      groupBy: [{ property: 'state' }],
      aggregates: [
        { method: 'count', alias: 'PartCount' },
        { property: 'unitPrice', method: 'avg', alias: 'AvgPrice' },
      ],
    });
    expect(result.content[0].text).toContain(
      '$apply=groupby((state),aggregate($count as PartCount,avg(unitPrice) as AvgPrice))',
    );
  });

  it('reports invalid aggregates as errors', async () => {
    const handler = await windchillHandler();
    const result = await handler('build_query', {
      entitySet: 'Parts',
      aggregates: [{ property: 'number', method: 'sum' }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('requires a numeric property');
  });
});

describe('lookup helpers', () => {
  it('matches relationships by qualified entity name', async () => {
    const handler = await windchillHandler();
    const result = await handler('get_relationships', {
      entityName: 'PTC.ProdMgmt.ElectricalPart',
    });

    // ElectricalPart inherits Part navs, so it has relationships via its base type.
    const inherited = await handler('get_relationships', { entityName: 'Part' });
    expect(inherited.content[0].text).toContain('Part_Documents');

    const qualifiedBase = await handler('get_relationships', {
      entityName: 'PTC.ProdMgmt.Part',
    });
    expect(qualifiedBase.content[0].text).toContain('Part_Documents');
    expect(result.isError).toBeFalsy();
  });

  it('searches inherited properties and navigation properties', async () => {
    const handler = await windchillHandler();

    const inherited = await handler('search_entities', { query: 'description' });
    expect(inherited.content[0].text).toContain('PTC.ProdMgmt.Part');

    const nav = await handler('search_entities', { query: 'SourcePart' });
    expect(nav.content[0].text).toContain('PTC.ProdMgmt.Part');
  });

  it('resolves enum members and type definitions behind Collection(...)', async () => {
    const handler = await edgeCaseHandler();
    const details = await handler('get_entity_details', { entityName: 'Thing' });
    const text = details.content[0].text;
    expect(text).toContain('Collection(Edge.Color (enum: RED | BLUE))');
    expect(text).toContain('Collection(Edge.Code (type definition of Edm.String))');
  });

  it('reports effective property counts in entity summaries', async () => {
    const handler = await windchillHandler();
    const list = await handler('list_entities', { limit: 50 });
    // ElectricalPart declares 1 property but inherits 10.
    expect(list.content[0].text).toContain('PTC.ProdMgmt.ElectricalPart');
    expect(list.content[0].text).toMatch(/ElectricalPart[^-\n]*- 11 props, 2 navs/);
  });
});

describe('error handling and pagination', () => {
  it('does not crash when an entity set references an unresolved entity type', async () => {
    const handler = await edgeCaseHandler();
    const result = await handler('get_action_details', { name: 'Touch' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Edge.Touch');
    expect(result.content[0].text).toContain('is not defined in the loaded metadata');
  });

  it('reports a clear range when offset is beyond the end', async () => {
    const handler = await windchillHandler();
    const result = await handler('list_entities', { offset: 500 });
    expect(result.content[0].text).toContain('No results at offset 500 (9 total)');
  });

  it('reports the shown range when offset is non-zero', async () => {
    const handler = await windchillHandler();
    const result = await handler('list_entity_sets', { offset: 1, limit: 2 });
    expect(result.content[0].text).toContain('Showing 2-3 of 4');
  });

  it('caps the page size so huge limits cannot flood the response', async () => {
    const { parseCSDL } = await import('@odata-visualizer/shared');
    const manyEntities = Array.from(
      { length: 300 },
      (_, i) => `<EntityType Name="E${i}"><Key><PropertyRef Name="Id"/></Key><Property Name="Id" Type="Edm.Int32"/></EntityType>`,
    ).join('');
    const csdl = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices><Schema Namespace="Big" xmlns="http://docs.oasis-open.org/odata/ns/edm">
    ${manyEntities}
  </Schema></edmx:DataServices>
</edmx:Edmx>`;

    const store = createMetadataStore();
    store.set(await parseCSDL(csdl), { sourceName: 'big.xml' });
    const result = await createToolHandler(store)('list_entities', { limit: 100000 });

    expect(result.content[0].text).toContain('Showing 1-200 of 300');
  });

  it('points at the UI upload when load_metadata is disabled', async () => {
    const handler = createToolHandler(createMetadataStore(), { allowLoadMetadata: false });
    const status = await handler('get_metadata_status', {});
    expect(status.content[0].text).toContain('Upload a file in the OData Visualizer UI');
    expect(status.content[0].text).not.toContain('call load_metadata');

    const list = await handler('list_entities', {});
    expect(list.isError).toBe(true);
    expect(list.content[0].text).toContain('Upload a file in the OData Visualizer UI');
  });
});

describe('load_metadata from backend server', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches the current metadata from the backend API', async () => {
    const { parseCSDL } = await import('@odata-visualizer/shared');
    const { readFileSync } = await import('node:fs');
    const metadata = await parseCSDL(readFileSync(windchillFixture, 'utf-8'));

    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ success: true, metadata }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    resetMetadata();
    const result = await handleToolCall('load_metadata', {
      source: 'http://backend.test:3001',
      type: 'server',
    });

    expect(result.isError).toBeUndefined();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://backend.test:3001/api/metadata/current');
    expect(getMetadata()?.entityContainers.length).toBeGreaterThan(0);

    const list = await handleToolCall('list_entity_sets', {});
    expect(list.content[0].text).toContain('Parts');
  });

  it('errors clearly when the backend has no metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ success: true, metadata: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    resetMetadata();
    const result = await handleToolCall('load_metadata', { type: 'server' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No metadata');
  });

  it('errors when the backend is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );

    resetMetadata();
    const result = await handleToolCall('load_metadata', { type: 'server' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Error loading metadata');
  });

  it('explains when the backend URL returns something other than JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<html>not the api</html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    resetMetadata();
    const result = await handleToolCall('load_metadata', {
      type: 'server',
      source: 'http://localhost:9999',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('JSON');
  });
});

