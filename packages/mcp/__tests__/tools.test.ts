import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  createToolHandler,
  handleToolCall,
  getMetadata,
  resetMetadata,
  type ToolHandlerOptions,
} from '../src/tools.js';
import { createMetadataStore } from '../src/store.js';
import { textOf } from './textOf.js';

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
  return writeCsdl(minimalCSDL);
}

async function writeCsdl(content: string): Promise<string> {
  const { mkdtemp, writeFile } = await import('fs/promises');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const dir = await mkdtemp(join(tmpdir(), 'mcp-test-'));
  const file = join(dir, 'metadata.xml');
  await writeFile(file, content, 'utf-8');
  return file;
}

beforeEach(() => {
  resetMetadata();
});

describe('handleToolCall', () => {
  it('returns isError when source is missing for load_metadata', async () => {
    const result = await handleToolCall('load_metadata', { type: 'file' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('source is required');
  });

  it('returns isError when metadata not loaded', async () => {
    const result = await handleToolCall('list_entities', {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('No metadata loaded');
  });

  it('loads metadata from a file and lists entities', async () => {
    const file = await writeFixture();
    const load = await handleToolCall('load_metadata', { source: file, type: 'file' });
    expect(load.isError).toBeUndefined();
    expect(textOf(load)).toContain('Successfully loaded');
    expect(getMetadata()?.entities).toHaveLength(2);

    const list = await handleToolCall('list_entities', {});
    expect(list.isError).toBeUndefined();
    expect(textOf(list)).toContain('Product');
    expect(textOf(list)).toContain('Category');
  });

  it('returns entity details with navigation target types', async () => {
    const file = await writeFixture();
    await handleToolCall('load_metadata', { source: file, type: 'file' });

    const details = await handleToolCall('get_entity_details', { entityName: 'product' });
    expect(details.isError).toBeUndefined();
    expect(textOf(details)).toContain('Entity: Test.Models.Product');
    expect(textOf(details)).toContain('Category -> Test.Models.Category');
  });

  it('renders a targeted description in get_entity_details', async () => {
    const { mkdtemp, writeFile } = await import('fs/promises');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = await mkdtemp(join(tmpdir(), 'mcp-test-'));
    const file = join(dir, 'metadata.xml');
    await writeFile(
      file,
      `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Test.Models" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Product">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.Int32" Nullable="false" />
      </EntityType>
      <Annotations Target="Test.Models.Product">
        <Annotation Term="Core.Description" String="A sellable product" />
      </Annotations>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`,
      'utf-8',
    );
    await handleToolCall('load_metadata', { source: file, type: 'file' });

    // Populating annotations changes MCP output: the label becomes a `Label:`
    // line and the annotation an `Annotations:` entry.
    const details = await handleToolCall('get_entity_details', { entityName: 'Product' });
    expect(textOf(details)).toContain('Label: A sellable product');
    expect(textOf(details)).toContain('- Core.Description: A sellable product');
  });

  it('returns isError for unknown entity', async () => {
    const file = await writeFixture();
    await handleToolCall('load_metadata', { source: file, type: 'file' });

    const details = await handleToolCall('get_entity_details', { entityName: 'Nope' });
    expect(details.isError).toBe(true);
    expect(textOf(details)).toContain('No entity matching');
  });

  it('lists V4 relationships derived from navigation properties', async () => {
    const file = await writeFixture();
    await handleToolCall('load_metadata', { source: file, type: 'file' });

    const rels = await handleToolCall('get_relationships', {});
    expect(rels.isError).toBeUndefined();
    expect(textOf(rels)).toContain('Product');
    expect(textOf(rels)).toContain('Category');
  });

  it('returns isError for load failure', async () => {
    const result = await handleToolCall('load_metadata', {
      source: '/nonexistent/path.xml',
      type: 'file',
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Error loading metadata');
  });

  it('returns isError for unknown tool', async () => {
    const result = await handleToolCall('nope', {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Unknown tool');
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
    const text = textOf(result);
    expect(text).toContain('Actions: 4');
    expect(text).toContain('Functions: 2');
    expect(text).toContain('Enums: 1');
    expect(text).toContain('Entities: 9');
  });

  it('searches entities by name and label', async () => {
    const byName = await handleToolCall('search_entities', { query: 'electrical' });
    expect(textOf(byName)).toContain('ElectricalPart');

    const byLabel = await handleToolCall('search_entities', { query: 'product structure part' });
    expect(textOf(byLabel)).toContain('PTC.ProdMgmt.Part');
  });

  it('resolves namespace collisions by qualified name', async () => {
    const ambiguous = await handleToolCall('get_entity_details', { entityName: 'Part' });
    expect(ambiguous.isError).toBe(true);
    expect(textOf(ambiguous)).toContain('ambiguous');

    const qualified = await handleToolCall('get_entity_details', {
      entityName: 'PTC.ProdMgmt.Part',
    });
    expect(qualified.isError).toBeUndefined();
    expect(textOf(qualified)).toContain('PTC.ProdMgmt.Part');
  });

  it('shows inheritance-resolved properties with source types', async () => {
    const details = await handleToolCall('get_entity_details', {
      entityName: 'PTC.ProdMgmt.ElectricalPart',
    });
    const text = textOf(details);
    expect(text).toContain('ElectricalPart -> Part -> WindchillEntity');
    expect(text).toContain('ID: Edm.String [KEY, non-nullable] (from WindchillEntity)');
    expect(text).toContain('voltageRating: Edm.Double');
    expect(text).toContain(
      'state: PTC.ProdMgmt.LifeCycleState (enum: INWORK | RELEASED | OBSOLETE)',
    );
    expect(text).toContain('number: PTC.ProdMgmt.PartNumber (type definition of Edm.String)');
    expect(text).toContain('weight: PTC.ProdMgmt.Quantity');
  });

  it('lists entity sets with capabilities and navigation bindings', async () => {
    const sets = await handleToolCall('list_entity_sets', {});
    const text = textOf(sets);
    expect(text).toContain('Parts -> PTC.ProdMgmt.Part [create, update, delete, navigate]');
    expect(text).toContain('bindings: Documents->CADDocuments');
  });

  it('lists and describes actions', async () => {
    const list = await handleToolCall('list_actions', { bound: true });
    expect(textOf(list)).toContain('PTC.ProdMgmt.GetPartStructure [bound]');
    expect(textOf(list)).not.toContain('CreateParts');

    const details = await handleToolCall('get_action_details', {
      name: 'GetPartStructure',
    });
    const text = textOf(details);
    expect(text).toContain('Bound action');
    expect(text).toContain('Return type: Collection(PTC.ProdMgmt.PartStructureItem)');
    expect(text).toContain('Part: PTC.ProdMgmt.Part (binding)');
    expect(text).toContain('Use build_action_invocation');
  });

  it('lists and describes functions', async () => {
    const list = await handleToolCall('list_functions', { bound: false });
    expect(textOf(list)).toContain('GetWindchillMetaInfo');
    expect(textOf(list)).not.toContain('GetPartEstimate');

    const details = await handleToolCall('get_function_details', {
      name: 'GetWindchillMetaInfo',
    });
    expect(textOf(details)).toContain('Import: GetWindchillMetaInfo');
    expect(textOf(details)).toContain('EntityName: Edm.String');
  });

  it('lists enums and type definitions', async () => {
    const result = await handleToolCall('list_enums', {});
    const text = textOf(result);
    expect(text).toContain(
      'PTC.ProdMgmt.LifeCycleState (Edm.String): INWORK=0, RELEASED=1, OBSOLETE=2',
    );
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
    expect(textOf(result)).toContain(
      "https://host/Windchill/servlet/odata/ProdMgmt/Parts?$filter=state%20eq%20PTC.ProdMgmt.LifeCycleState'RELEASED'%20and%20unitPrice%20gt%2010&$expand=Documents($select=ID)&$orderby=number%20desc&$top=5",
    );
  });

  it('warns on unknown entity set', async () => {
    const result = await handleToolCall('build_query', { entitySet: 'Partz' });
    expect(textOf(result)).toContain('not a known entity set');
    expect(textOf(result)).toContain('Parts');
  });

  it('accepts a key predicate in entitySet, as the tool description advertises', async () => {
    const result = await handleToolCall('build_query', {
      entitySet: "Parts('OR:wt.part.WTPart:123')",
      top: 1,
    });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("GET /Parts('OR:wt.part.WTPart:123')?$top=1");
    // The keyed path resolves to the same set, so it must not draw the
    // "not a known entity set" note.
    expect(textOf(result)).not.toContain('not a known entity set');
  });

  it('builds a bound action invocation with typed body', async () => {
    const result = await handleToolCall('build_action_invocation', {
      actionName: 'GetPartStructure',
      entitySet: 'Parts',
      keys: { ID: 'OR:wt.part.WTPart:123' },
      parameters: { ShowSingleLevelReport: 'true' },
      baseUrl: 'https://host/Windchill/servlet/odata/ProdMgmt',
    });
    const text = textOf(result);
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
    expect(textOf(result)).toContain('Missing key value(s): ID');
  });

  it('builds an unbound function invocation with inline literals', async () => {
    const result = await handleToolCall('build_function_invocation', {
      functionName: 'GetWindchillMetaInfo',
      parameters: { EntityName: 'Part', IncludeAncestorProperty: 'true' },
      baseUrl: 'https://host/Windchill/servlet/odata/ProdMgmt',
    });
    const text = textOf(result);
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
    expect(textOf(result)).toContain(
      "GET <serviceRoot>/Parts('OR:wt.part.WTPart:123')/PTC.ProdMgmt.GetPartEstimate(Quantity=12.5)",
    );
  });
});

/**
 * Populating annotations changes what MCP renders: `describeCallable` appends
 * `label` and `formatCallableDetails` prints it as a Description. A targeted
 * action annotation could never reach either before the resolver understood
 * `NS.Action` targets.
 */
describe('targeted annotations reach tool output', () => {
  it('renders an action description applied by a schema-level Annotations block', async () => {
    resetMetadata();
    const file = await writeCsdl(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Demo" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <Action Name="Reset">
        <Parameter Name="Hard" Type="Edm.Boolean" Nullable="true" />
      </Action>
      <EntityContainer Name="Container">
        <ActionImport Name="Reset" Action="Demo.Reset" />
      </EntityContainer>
      <Annotations Target="Demo.Reset">
        <Annotation Term="Core.Description" String="Resets the whole model" />
      </Annotations>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);
    const load = await handleToolCall('load_metadata', { source: file, type: 'file' });
    expect(load.isError).toBeUndefined();

    const details = await handleToolCall('get_action_details', { name: 'Reset' });
    expect(details.isError).toBeUndefined();
    expect(textOf(details)).toContain('Description: Resets the whole model');
  });
});

describe('createToolHandler', () => {
  it('errors with no metadata when the injected store is empty', async () => {
    const handler = createToolHandler(createMetadataStore());
    const result = await handler('list_entities', {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('No metadata loaded');
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
    expect(textOf(result)).toContain('Parts -> PTC.ProdMgmt.Part');
  });

  it('reports the loaded source via get_metadata_status', async () => {
    const { parseCSDL } = await import('@odata-visualizer/shared');
    const { readFileSync } = await import('node:fs');
    const xml = readFileSync(windchillFixture, 'utf-8');

    const store = createMetadataStore();
    store.set(await parseCSDL(xml), { sourceName: 'windchill.xml', sourceType: 'file' });
    const result = await createToolHandler(store)('get_metadata_status', {});

    const text = textOf(result);
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
    expect(textOf(result)).toContain('Unresolved references: missing.xml');
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

    const text = textOf(result);
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

    const text = textOf(result);
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

    const text = textOf(result);
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
    expect(textOf(result)).toContain('Unknown parameter "Bogus"');
    expect(textOf(result)).toContain('ShowSingleLevelReport');
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
    expect(textOf(result)).toContain('Invalid Edm.Boolean');
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
    expect(textOf(result)).toContain('Invalid Edm.Double');
  });

  it('emits a null literal for null function parameters', async () => {
    const handler = await windchillHandler();
    const result = await handler('build_function_invocation', {
      functionName: 'GetWindchillMetaInfo',
      parameters: { EntityName: null, IncludeAncestorProperty: 'true' },
    });

    expect(textOf(result)).toContain(
      'GET <serviceRoot>/GetWindchillMetaInfo(EntityName=null,IncludeAncestorProperty=true)',
    );
  });

  it('shell-escapes single quotes in the generated curl example', async () => {
    const handler = await windchillHandler();
    const result = await handler('build_action_invocation', {
      actionName: 'CreateParts',
      parameters: { PartNames: ["O'Brien"] },
    });

    const text = textOf(result);
    expect(text).toContain("O'\\''Brien");
  });

  it('does not emit a Content-Type header for GET function invocations', async () => {
    const handler = await windchillHandler();
    const result = await handler('build_function_invocation', {
      functionName: 'GetWindchillMetaInfo',
      parameters: { EntityName: 'Part' },
    });

    expect(textOf(result)).not.toContain('Content-Type');
  });

  it('addresses an unbound action with no import by its qualified name', async () => {
    const handler = await edgeCaseHandler();
    const result = await handler('build_action_invocation', {
      actionName: 'Reset',
      parameters: { Scope: 'all' },
    });
    expect(textOf(result)).toContain('POST <serviceRoot>/Edge.Reset');
  });

  it('addresses an unbound function with no import by its qualified name', async () => {
    const handler = await edgeCaseHandler();
    const result = await handler('build_function_invocation', {
      functionName: 'Lookup',
      parameters: { Term: 'x' },
    });
    expect(textOf(result)).toContain("GET <serviceRoot>/Edge.Lookup(Term='x')");
  });
});

describe('build_query diagnostics', () => {
  it('warns about unknown $select properties', async () => {
    const handler = await windchillHandler();
    const result = await handler('build_query', {
      entitySet: 'Parts',
      select: ['ID', 'Nmae'],
    });
    const text = textOf(result);
    expect(text).toContain('GET /Parts?$select=ID,Nmae');
    expect(text).toContain('"Nmae" is not a property of PTC.ProdMgmt.Part');
  });

  it('warns about unknown $orderby fields', async () => {
    const handler = await windchillHandler();
    const result = await handler('build_query', {
      entitySet: 'Parts',
      orderBy: 'nmae desc',
    });
    expect(textOf(result)).toContain('"nmae" is not a property of PTC.ProdMgmt.Part');
  });

  it('warns about unknown $filter properties', async () => {
    const handler = await windchillHandler();
    const result = await handler('build_query', {
      entitySet: 'Parts',
      filters: [{ property: 'nope', operator: 'eq', value: '1' }],
    });
    expect(textOf(result)).toContain('"nope" is not a property of PTC.ProdMgmt.Part');
  });

  it('warns about unknown $expand navigation properties', async () => {
    const handler = await windchillHandler();
    const result = await handler('build_query', {
      entitySet: 'Parts',
      expand: [{ navProperty: 'NoSuchNav' }],
    });
    expect(textOf(result)).toContain(
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
    expect(textOf(result)).toContain('Documents/Missing');
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
    expect(textOf(result)).not.toContain('not a property');
    expect(textOf(result)).not.toContain('not a navigation property');
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
    expect(textOf(result)).toContain(
      '$apply=groupby((state),aggregate($count%20as%20PartCount,avg(unitPrice)%20as%20AvgPrice))',
    );
  });

  it('reports invalid aggregates as errors', async () => {
    const handler = await windchillHandler();
    const result = await handler('build_query', {
      entitySet: 'Parts',
      aggregates: [{ property: 'number', method: 'sum' }],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('requires a numeric property');
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
    expect(textOf(inherited)).toContain('Part_Documents');

    const qualifiedBase = await handler('get_relationships', {
      entityName: 'PTC.ProdMgmt.Part',
    });
    expect(textOf(qualifiedBase)).toContain('Part_Documents');
    expect(result.isError).toBeFalsy();
  });

  it('searches inherited properties and navigation properties', async () => {
    const handler = await windchillHandler();

    const inherited = await handler('search_entities', { query: 'description' });
    expect(textOf(inherited)).toContain('PTC.ProdMgmt.Part');

    const nav = await handler('search_entities', { query: 'SourcePart' });
    expect(textOf(nav)).toContain('PTC.ProdMgmt.Part');
  });

  it('resolves enum members and type definitions behind Collection(...)', async () => {
    const handler = await edgeCaseHandler();
    const details = await handler('get_entity_details', { entityName: 'Thing' });
    const text = textOf(details);
    expect(text).toContain('Collection(Edge.Color (enum: RED | BLUE))');
    expect(text).toContain('Collection(Edge.Code (type definition of Edm.String))');
  });

  it('reports effective property counts in entity summaries', async () => {
    const handler = await windchillHandler();
    const list = await handler('list_entities', { limit: 50 });
    // ElectricalPart declares 1 property but inherits 10.
    expect(textOf(list)).toContain('PTC.ProdMgmt.ElectricalPart');
    expect(textOf(list)).toMatch(/ElectricalPart[^-\n]*- 11 props, 2 navs/);
  });
});

describe('error handling and pagination', () => {
  it('does not crash when an entity set references an unresolved entity type', async () => {
    const handler = await edgeCaseHandler();
    const result = await handler('get_action_details', { name: 'Touch' });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('Edge.Touch');
    expect(textOf(result)).toContain('is not defined in the loaded metadata');
  });

  it('reports a clear range when offset is beyond the end', async () => {
    const handler = await windchillHandler();
    const result = await handler('list_entities', { offset: 500 });
    expect(textOf(result)).toContain('No results at offset 500 (9 total)');
  });

  it('reports the shown range when offset is non-zero', async () => {
    const handler = await windchillHandler();
    const result = await handler('list_entity_sets', { offset: 1, limit: 2 });
    expect(textOf(result)).toContain('Showing 2-3 of 4');
  });

  it('caps the page size so huge limits cannot flood the response', async () => {
    const { parseCSDL } = await import('@odata-visualizer/shared');
    const manyEntities = Array.from(
      { length: 300 },
      (_, i) =>
        `<EntityType Name="E${i}"><Key><PropertyRef Name="Id"/></Key><Property Name="Id" Type="Edm.Int32"/></EntityType>`,
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

    expect(textOf(result)).toContain('Showing 1-200 of 300');
  });

  it('points at the UI upload when load_metadata is disabled', async () => {
    const handler = createToolHandler(createMetadataStore(), { allowLoadMetadata: false });
    const status = await handler('get_metadata_status', {});
    expect(textOf(status)).toContain('Upload a file in the OData Visualizer UI');
    expect(textOf(status)).not.toContain('call load_metadata');

    const list = await handler('list_entities', {});
    expect(list.isError).toBe(true);
    expect(textOf(list)).toContain('Upload a file in the OData Visualizer UI');
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

    const fetchMock = vi.fn(
      async (_url: string) =>
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
    expect(textOf(list)).toContain('Parts');
  });

  it('errors clearly when the backend has no metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ success: true, metadata: null }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );

    resetMetadata();
    const result = await handleToolCall('load_metadata', { type: 'server' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('No metadata');
  });

  it('errors when the backend is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );

    resetMetadata();
    const result = await handleToolCall('load_metadata', { type: 'server' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Error loading metadata');
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
    expect(textOf(result)).toContain('JSON');
  });
});

/**
 * The tool's deliverable is a URL the caller copies into a request. An
 * unencoded space, `#`, `?` or `%` in an inline parameter or key value makes
 * that URL either unparseable (`curl: (3) URL rejected`) or silently truncated
 * at a fragment boundary.
 */
describe('inline parameter encoding', () => {
  beforeEach(async () => {
    resetMetadata();
    await loadWindchill();
  });

  /** The `<METHOD> <url>` line the tool prints. Actions emit POST, functions GET. */
  function emittedUrl(text: string): string {
    const line = text.split('\n').find((l) => l.startsWith('GET ') || l.startsWith('POST '));
    return (line ?? '').replace(/^(GET|POST) /, '');
  }

  it('percent-encodes a string parameter containing a space', async () => {
    const result = await handleToolCall('build_function_invocation', {
      functionName: 'GetWindchillMetaInfo',
      parameters: { EntityName: 'ball bearing' },
      baseUrl: 'https://host/Windchill/servlet/odata/ProdMgmt',
    });

    const url = emittedUrl(textOf(result));
    expect(url).toContain('ball%20bearing');
    // A raw space is what made `curl` reject the whole request.
    expect(url).not.toContain(' ');
  });

  it('percent-encodes a slash so the value stays one path segment', async () => {
    const result = await handleToolCall('build_function_invocation', {
      functionName: 'GetWindchillMetaInfo',
      parameters: { EntityName: 'a/b' },
      baseUrl: 'https://host/Windchill/servlet/odata/ProdMgmt',
    });

    const url = emittedUrl(textOf(result));
    // A raw slash would split the value into two path segments, addressing a
    // different resource entirely — and `curl` would still accept the URL.
    expect(url).toContain('a%2Fb');
    expect(new URL(url).pathname).toBe(
      "/Windchill/servlet/odata/ProdMgmt/GetWindchillMetaInfo(EntityName='a%2Fb')",
    );
  });

  it('percent-encodes a value that would otherwise smuggle an encoded slash', async () => {
    const result = await handleToolCall('build_function_invocation', {
      functionName: 'GetWindchillMetaInfo',
      parameters: { EntityName: 'a%2Fb' },
      baseUrl: 'https://host/Windchill/servlet/odata/ProdMgmt',
    });

    // Values are raw data, never pre-encoded URL text, so `%` is escaped too.
    expect(emittedUrl(textOf(result))).toContain('a%252Fb');
  });

  it('percent-encodes characters that would truncate the URL', async () => {
    const result = await handleToolCall('build_function_invocation', {
      functionName: 'GetWindchillMetaInfo',
      parameters: { EntityName: 'a#b?c%d' },
      baseUrl: 'https://host/Windchill/servlet/odata/ProdMgmt',
    });

    const url = emittedUrl(textOf(result));
    const parsed = new URL(url);
    // `#` would start a fragment and `?` a query string; neither is part of the
    // resource path, so the path must still carry the whole value.
    expect(parsed.hash).toBe('');
    expect(parsed.search).toBe('');
    expect(decodeURIComponent(parsed.pathname)).toContain("'a#b?c%d'");
  });

  it('percent-encodes non-ASCII and emoji as UTF-8', async () => {
    const result = await handleToolCall('build_function_invocation', {
      functionName: 'GetWindchillMetaInfo',
      parameters: { EntityName: 'café 🎉' },
      baseUrl: 'https://host/Windchill/servlet/odata/ProdMgmt',
    });

    const url = emittedUrl(textOf(result));
    expect(url).toContain('caf%C3%A9');
    // One code point, encoded as four UTF-8 bytes, not two surrogate halves.
    expect(url).toContain('%F0%9F%8E%89');
    expect(decodeURIComponent(url)).toContain("'café 🎉'");
  });

  it('percent-encodes control characters', async () => {
    const result = await handleToolCall('build_function_invocation', {
      functionName: 'GetWindchillMetaInfo',
      parameters: { EntityName: 'a\nb\tc' },
      baseUrl: 'https://host/Windchill/servlet/odata/ProdMgmt',
    });

    const url = emittedUrl(textOf(result));
    expect(url).toContain('a%0Ab%09c');
    expect(url).not.toMatch(/[\n\t]/);
  });

  it('reports an unpaired surrogate clearly instead of "URI malformed"', async () => {
    const result = await handleToolCall('build_function_invocation', {
      functionName: 'GetWindchillMetaInfo',
      parameters: { EntityName: '\ud800' },
      baseUrl: 'https://host/Windchill/servlet/odata/ProdMgmt',
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('unpaired surrogate');
    expect(textOf(result)).not.toContain('URI malformed');
  });

  it('escapes the OData literal and URL-encodes it independently', async () => {
    const result = await handleToolCall('build_function_invocation', {
      functionName: 'GetWindchillMetaInfo',
      // Both a character OData escapes (') and one the URL must encode (space),
      // so the test fails if either step stops happening.
      parameters: { EntityName: "O'Brien Smith" },
      baseUrl: 'https://host/Windchill/servlet/odata/ProdMgmt',
    });

    const url = emittedUrl(textOf(result));
    // OData doubles the apostrophe; the space is the part the URL must encode.
    // Either step stopping would fail this.
    expect(url).toContain("'O''Brien%20Smith'");
    expect(decodeURIComponent(url)).toContain("'O''Brien Smith'");
  });

  it('percent-encodes a key value containing a space or fragment', async () => {
    const result = await handleToolCall('build_action_invocation', {
      actionName: 'GetPartStructure',
      entitySet: 'Parts',
      keys: { ID: 'OR:wt part#1' },
      baseUrl: 'https://host/Windchill/servlet/odata/ProdMgmt',
    });

    const url = emittedUrl(textOf(result));
    expect(url).not.toContain(' ');
    const parsed = new URL(url);
    expect(parsed.hash).toBe('');
    expect(decodeURIComponent(parsed.pathname)).toContain("'OR:wt part#1'");
  });

  it('still emits the plain form when nothing needs encoding', async () => {
    const result = await handleToolCall('build_function_invocation', {
      functionName: 'GetPartEstimate',
      entitySet: 'Parts',
      keys: { ID: 'OR:wt.part.WTPart:123' },
      parameters: { Quantity: 12.5 },
      baseUrl: 'https://host/Windchill/servlet/odata/ProdMgmt',
    });

    // Colons in a key are legal in a path segment and must not be mangled.
    expect(textOf(result)).toContain(
      "/Parts('OR:wt.part.WTPart:123')/PTC.ProdMgmt.GetPartEstimate(Quantity=12.5)",
    );
  });
});

/**
 * A composite key takes the `(A=...,B=...)` form, a different branch from the
 * single-key `(...)`. No fixture in the repo has a composite key, so this
 * builds one — the branch was previously uncovered, and a mutation removing its
 * encoding survived the whole suite.
 */
describe('composite key encoding', () => {
  const compositeCsdl = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Pair">
        <Key>
          <PropertyRef Name="A" />
          <PropertyRef Name="B" />
        </Key>
        <Property Name="A" Type="Edm.String" Nullable="false" />
        <Property Name="B" Type="Edm.String" Nullable="false" />
      </EntityType>
      <Action Name="Touch" IsBound="true">
        <Parameter Name="it" Type="N.Pair" />
        <Parameter Name="Note" Type="Edm.String" />
      </Action>
      <EntityContainer Name="Container">
        <EntitySet Name="Pairs" EntityType="N.Pair" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

  async function compositeHandler() {
    const { parseCSDL } = await import('@odata-visualizer/shared');
    const store = createMetadataStore();
    store.set(await parseCSDL(compositeCsdl), { sourceName: 'composite.xml', sourceType: 'file' });
    return createToolHandler(store, { allowLoadMetadata: false });
  }

  it('encodes each key value in the A=...,B=... form', async () => {
    const handler = await compositeHandler();
    const result = await handler('build_action_invocation', {
      actionName: 'Touch',
      entitySet: 'Pairs',
      keys: { A: 'x y', B: 'p#q' },
      baseUrl: 'https://host/svc',
    });

    const url = textOf(result)
      .split('\n')
      .find((l) => l.startsWith('POST ') || l.startsWith('GET '))!
      .replace(/^(POST|GET) /, '');

    // Both names and both separators stay raw; only the values are encoded.
    expect(url).toContain("(A='x%20y',B='p%23q')");
    expect(new URL(url).hash).toBe('');
  });
});

/**
 * Action request bodies are JSON, not URL literals: `coerceScalar` must turn a
 * raw input into the exact number `JSON.stringify` will emit. No fixture in the
 * repo declares an action with a bounded integer parameter, so this one pins
 * Edm.Byte/SByte/Int16/Int32/Int64/Double body coercion at and past their limits.
 */
const numericCSDL = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Num" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Item">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.Int32" Nullable="false" />
      </EntityType>
      <Action Name="Adjust">
        <Parameter Name="Count" Type="Edm.Int32" />
        <Parameter Name="Big" Type="Edm.Int64" />
        <Parameter Name="Small" Type="Edm.Byte" />
        <Parameter Name="Tiny" Type="Edm.SByte" />
        <Parameter Name="Short" Type="Edm.Int16" />
        <Parameter Name="Ratio" Type="Edm.Double" />
        <Parameter Name="Money" Type="Edm.Decimal" />
        <Parameter Name="Precise" Type="Edm.Single" />
        <Parameter Name="Grade" Type="Num.Score" />
        <Parameter Name="Counts" Type="Collection(Edm.Int32)" />
        <Parameter Name="Bigs" Type="Collection(Edm.Int64)" />
      </Action>
      <TypeDefinition Name="Score" UnderlyingType="Edm.Int32" />
      <EntityContainer Name="Container">
        <EntitySet Name="Items" EntityType="Num.Item" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

/** Calls `build_action_invocation` on an unbound action with numeric parameters. */
async function adjust(parameters: Record<string, unknown>, options: ToolHandlerOptions = {}) {
  const { parseCSDL } = await import('@odata-visualizer/shared');
  const store = createMetadataStore();
  store.set(await parseCSDL(numericCSDL), { sourceName: 'numeric.xml', sourceType: 'file' });
  const handler = createToolHandler(store, { allowLoadMetadata: false, ...options });
  return handler('build_action_invocation', { actionName: 'Adjust', parameters });
}

/**
 * The JSON body the tool prints between `Body:` and `Example:`, parsed. The
 * tool's deliverable is that text, so asserting on the parsed body pins the
 * digits actually emitted after `JSON.stringify`.
 */
function emittedBody(text: string): Record<string, unknown> {
  const match = /Body:\n([\s\S]*?)\nExample:/.exec(text);
  if (!match) throw new Error(`No body in tool output:\n${text}`);
  return JSON.parse(match[1]) as Record<string, unknown>;
}

describe('numeric action body coercion', () => {
  it('rejects 1e999 for Edm.Int64 instead of shipping JSON null', async () => {
    const result = await adjust({ Big: '1e999' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Invalid Edm.Int64');
  });

  it('rejects 1e999 for Edm.Double instead of shipping JSON null', async () => {
    const result = await adjust({ Ratio: '1e999' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Invalid Edm.Double');
  });

  it('rejects empty and whitespace-only strings for a numeric parameter', async () => {
    for (const empty of ['', '   ']) {
      const result = await adjust({ Count: empty });
      expect(result.isError, `input ${JSON.stringify(empty)} must be rejected`).toBe(true);
      expect(textOf(result)).toContain('Edm.Int32');
    }
  });

  it('rejects hex, fractional and exponent strings for an integer type', async () => {
    for (const bad of ['0x1F', '1.5', 1.5, '1e3']) {
      const result = await adjust({ Count: bad });
      expect(result.isError, `input ${JSON.stringify(bad)} must be rejected`).toBe(true);
      expect(textOf(result)).toContain('Invalid Edm.Int32');
    }
  });

  it('rejects out-of-range values for every bounded integer type', async () => {
    const cases = [
      { param: 'Small', type: 'Edm.Byte', value: '256' },
      { param: 'Small', type: 'Edm.Byte', value: -1 },
      { param: 'Small', type: 'Edm.Byte', value: 9999 },
      { param: 'Tiny', type: 'Edm.SByte', value: '128' },
      { param: 'Short', type: 'Edm.Int16', value: '32768' },
      { param: 'Count', type: 'Edm.Int32', value: '2147483648' },
    ];
    for (const { param, type, value } of cases) {
      const result = await adjust({ [param]: value });
      expect(result.isError, `${type}=${JSON.stringify(value)} must be rejected`).toBe(true);
      expect(textOf(result)).toContain(`Invalid ${type}`);
      expect(textOf(result)).toContain('out of range');
    }
  });

  /**
   * A JSON number is binary64 and stops carrying integers exactly at 2^53, so
   * the body path emits the validated literal as a JSON string instead and
   * declares `application/json;IEEE754Compatible=true`: the OData JSON Format
   * lets the service read that string back exactly. Both the printed
   * Content-Type and the curl example must carry the same media type.
   */
  it('accepts an Int64 past 2^53 as an IEEE754Compatible JSON string', async () => {
    // 2^53 + 1: in EDM Int64 range, but Number() rounds it to 2^53.
    const result = await adjust({ Big: '9007199254740993' });
    expect(result.isError).toBeUndefined();
    const text = textOf(result);
    expect(text).toContain('"Big": "9007199254740993"');
    expect(text).toContain('Content-Type: application/json;IEEE754Compatible=true');
    expect(text).toContain("-H 'Content-Type: application/json;IEEE754Compatible=true'");
    expect(text).not.toContain("-H 'Content-Type: application/json'");
  });

  it('string-encodes every Int64 whose JSON digits would differ from the input', async () => {
    // MAX rounds to 2^63; each of the others has an exact `Number`, but the
    // shortest round-tripping decimal JSON.stringify emits uses different
    // digits: 2^62 -> ...388000, 2^60 -> ...847000, MIN -> ...776000.
    for (const input of [
      '9223372036854775807',
      '4611686018427387904',
      '1152921504606846976',
      '-9223372036854775808',
      '-9007199254740993',
    ]) {
      const result = await adjust({ Big: input });
      expect(result.isError, `${input} must be accepted`).toBeUndefined();
      const text = textOf(result);
      expect(text).toContain('IEEE754Compatible=true');
      expect(emittedBody(text)['Big'], `${input} must be emitted verbatim`).toBe(input);
    }
  });

  it('keeps the refusal when IEEE754Compatible is disabled', async () => {
    // The plain `application/json` content type cannot carry the digits, so
    // the old refusal remains correct wherever string encoding is unavailable.
    for (const input of ['9007199254740993', '9223372036854775807', '-9007199254740993']) {
      const result = await adjust({ Big: input }, { ieee754Compatible: false });
      expect(result.isError, `${input} must be refused`).toBe(true);
      expect(textOf(result)).toContain('Invalid Edm.Int64');
      expect(textOf(result)).toContain('exact');
    }
  });

  it('accepts an Int64 value that survives the round trip through a number', async () => {
    const result = await adjust({ Big: '9007199254740992' }); // 2^53
    expect(result.isError).toBeUndefined();
    const text = textOf(result);
    expect(text).toContain('"Big": 9007199254740992');
    // Exactly representable: no gratuitous string encoding or content type.
    expect(text).toContain('Content-Type: application/json\n');
    expect(text).toContain("-H 'Content-Type: application/json'");
    expect(text).not.toContain('IEEE754Compatible');
  });

  it('emits an accepted Int64 with exactly the digits the caller sent', async () => {
    // Accepted values are the ones JSON.stringify prints verbatim; the guard
    // must not merely prove that both sides parse to the same BigInt.
    for (const input of ['9007199254740992', '-9007199254740992', '123456789']) {
      const result = await adjust({ Big: input });
      expect(result.isError, `${input} must be accepted`).toBeUndefined();
      const body = emittedBody(textOf(result));
      expect(String(body['Big']), `${input} must be emitted verbatim`).toBe(input);
    }
  });

  it('rejects Int64 input past the EDM 64-bit range', async () => {
    const result = await adjust({ Big: '99999999999999999999' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Invalid Edm.Int64');
    expect(textOf(result)).toContain('out of range');
  });

  it('still emits plain numbers for valid values', async () => {
    const result = await adjust({
      Count: '42',
      Big: '-5',
      Small: 200,
      Tiny: -128,
      Short: '32767',
      Ratio: 12.5,
    });
    expect(result.isError).toBeUndefined();
    const text = textOf(result);
    expect(text).toContain('"Count": 42');
    expect(text).toContain('"Big": -5');
    expect(text).toContain('"Small": 200');
    expect(text).toContain('"Tiny": -128');
    expect(text).toContain('"Short": 32767');
    expect(text).toContain('"Ratio": 12.5');
  });

  it('trims surrounding whitespace around numeric body values', async () => {
    const result = await adjust({ Count: ' 42 ' });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('"Count": 42');
  });

  it('keeps an explicit null parameter as JSON null', async () => {
    const result = await adjust({ Count: null });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('"Count": null');
  });

  it('rejects the string "null" for a numeric parameter (JSON null is null, the value)', async () => {
    const result = await adjust({ Ratio: 'null' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Invalid Edm.Double');
  });

  it('validates a body parameter through a type definition to its underlying type', async () => {
    const result = await adjust({ Grade: '1.5' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Invalid Edm.Int32');
  });

  it('validates each element of a numeric collection body parameter', async () => {
    const ok = await adjust({ Counts: ['1', '2'] });
    expect(ok.isError).toBeUndefined();
    expect(textOf(ok)).toContain('"Counts": [');
    expect(textOf(ok)).toMatch(/\[\s*1,\s*2\s*\]/);

    const bad = await adjust({ Counts: ['1', 'x'] });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('Invalid Edm.Int32');
  });

  it('string-encodes a collection element and marks the body compatible', async () => {
    const result = await adjust({ Bigs: ['9007199254740993'] });
    expect(result.isError).toBeUndefined();
    const text = textOf(result);
    expect(emittedBody(text)['Bigs']).toEqual(['9007199254740993']);
    expect(text).toContain('IEEE754Compatible=true');
  });

  /**
   * Edm.Decimal is a decimal type: the JSON body must denote the same decimal
   * the caller sent. `Number` rounds most 38-digit values, and JSON.stringify
   * prints the shortest round-tripping decimal, so both steps need checking —
   * `BigInt` cannot be used because Decimal literals may have a fraction or an
   * exponent. A decimal that survives neither test is emitted as the literal
   * string under the compatible content type, exactly like Edm.Int64.
   */
  it('accepts a Decimal whose JSON serialization denotes the same value', async () => {
    const cases: Array<[string, number]> = [
      ['1.5', 1.5],
      ['0.1', 0.1],
      ['-0.25', -0.25],
      // 1e5 and 100000 are the same decimal; JSON prints the plain spelling.
      ['1e5', 100000],
    ];
    for (const [input, expected] of cases) {
      const result = await adjust({ Money: input });
      expect(result.isError, `${input} must be accepted`).toBeUndefined();
      const body = emittedBody(textOf(result));
      expect(body['Money'], `${input} must be emitted as ${expected}`).toBe(expected);
    }
  });

  it('emits a Decimal past binary64 precision as an IEEE754Compatible string', async () => {
    // 2^53 + 1 -> JSON prints ...992; a 20-significant-digit fraction
    // collapses to 1. A bare JSON number would silently carry a different
    // decimal than the caller sent, so the literal becomes a JSON string.
    for (const input of ['9007199254740993', '1.0000000000000000001', '0.30000000000000000001']) {
      const result = await adjust({ Money: input });
      expect(result.isError, `${input} must be accepted`).toBeUndefined();
      const text = textOf(result);
      expect(text).toContain('IEEE754Compatible=true');
      expect(emittedBody(text)['Money'], `${input} must be emitted verbatim`).toBe(input);
    }
  });

  it('keeps the 38-digit Decimal cap under IEEE754Compatible encoding', async () => {
    // The cap is a deliberate product limit, not a binary64 artifact, so it
    // must not be relaxed by the string encoding.
    const result = await adjust({ Money: '9'.repeat(39) });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Invalid Edm.Decimal');
  });

  it('keeps the Decimal refusal when IEEE754Compatible is disabled', async () => {
    const result = await adjust({ Money: '1.0000000000000000001' }, { ieee754Compatible: false });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Invalid Edm.Decimal');
    expect(textOf(result)).toContain('exact');
  });

  it('coerces Edm.Single to a JSON number, not a string', async () => {
    // Without Edm.Single in the numeric branch the raw string would travel
    // into the body and the service would reject it.
    const result = await adjust({ Precise: '1.5' });
    expect(result.isError).toBeUndefined();
    expect(emittedBody(textOf(result))['Precise']).toBe(1.5);
  });

  it('rejects a Single literal that overflows binary64', async () => {
    const result = await adjust({ Precise: '1e999' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Invalid Edm.Single');
  });

  it('no longer coerces booleans to 1/0 for a numeric parameter', async () => {
    // `Number(true)` used to reach the body as 1 and `Number(false)` as 0; the
    // literal formatter has no room for either and rejects the parameter.
    for (const input of [true, false]) {
      const result = await adjust({ Count: input });
      expect(result.isError, `${JSON.stringify(input)} must be rejected`).toBe(true);
      expect(textOf(result)).toContain('Invalid Edm.Int32');
    }
  });

  it('does not surface a raw BigInt conversion error when the shared integer set drifts', async () => {
    // The guard must use the formatter's own INTEGER_TYPES set. A private copy
    // can disagree with it — the reviewer removed Edm.Int64 from the shared
    // set and the copy still ran BigInt('1e5'), throwing SyntaxError into the
    // tool result. Sharing the set means the guard is skipped for any type the
    // formatter no longer treats as an integer.
    const { INTEGER_TYPES } = await import('@odata-visualizer/shared');
    INTEGER_TYPES.delete('Edm.Int64');
    try {
      const result = await adjust({ Big: '1e5' });
      expect(textOf(result)).not.toMatch(/BigInt|Cannot convert/);
    } finally {
      INTEGER_TYPES.add('Edm.Int64');
    }
  });
});

/**
 * The description is the only documentation an LLM sees before calling
 * build_action_invocation, so the refusal to coerce booleans and empty strings
 * for numeric parameters has to be visible there.
 */
describe('build_action_invocation tool description', () => {
  it('documents that numeric parameters reject booleans and empty strings', async () => {
    const { createMcpServer } = await import('../src/server.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const server = createMcpServer(createMetadataStore());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === 'build_action_invocation');
      expect(tool?.description).toContain('booleans and empty strings are rejected');
    } finally {
      await client.close();
    }
  });
});

/**
 * `resolveEntityArg` disambiguates for itself rather than going through
 * `findEntityByName`, so it needed the same exact-case policy. Two schemas
 * differing only in case made it answer a direct question with the other type's
 * shape, and an agent then builds filters against the wrong properties.
 */
describe('entity lookup under a case-only collision', () => {
  const caseCollision = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Shop" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Order">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <Property Name="ShopOnly" Type="Edm.String" />
      </EntityType>
    </Schema>
    <Schema Namespace="SHOP" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Order">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <Property Name="ShopUpperOnly" Type="Edm.String" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

  it('answers with the spelling that was asked for', async () => {
    const { parseCSDL } = await import('@odata-visualizer/shared');
    const store = createMetadataStore();
    store.set(await parseCSDL(caseCollision), { sourceName: 'case.xml', sourceType: 'file' });
    const handler = createToolHandler(store);

    const result = await handler('get_entity_details', { entityName: 'SHOP.Order' });
    const text = textOf(result);

    expect(text).toContain('SHOP.Order');
    expect(text).toContain('ShopUpperOnly');
    expect(text).not.toContain('ShopOnly');
  });
});

/**
 * Bound-function composition fixes: a collection binding composes on the
 * collection (no key predicate), an overload is selected from the supplied
 * parameter names, an omitted declared parameter is called out, and query
 * options that do not apply to a non-entity return are dropped with a warning.
 */
const boundCompositionCSDL = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="A">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <EntityType Name="C">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="Related" Type="N.D" />
      </EntityType>
      <EntityType Name="D">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <EntityType Name="Derived" BaseType="N.A" />
      <ComplexType Name="Addr">
        <Property Name="Street" Type="Edm.String" />
      </ComplexType>
      <Function Name="AllOf" IsBound="true">
        <Parameter Name="it" Type="Collection(N.A)" />
        <ReturnType Type="Collection(N.C)" />
      </Function>
      <Function Name="B" IsBound="true">
        <Parameter Name="it" Type="N.A" />
        <ReturnType Type="N.C" />
      </Function>
      <Function Name="B" IsBound="true">
        <Parameter Name="it" Type="N.A" />
        <Parameter Name="factor" Type="Edm.Int32" />
        <ReturnType Type="N.C" />
      </Function>
      <Function Name="Count" IsBound="true">
        <Parameter Name="it" Type="N.A" />
        <ReturnType Type="Edm.Int32" />
      </Function>
      <Function Name="Numbers" IsBound="true">
        <Parameter Name="it" Type="N.A" />
        <ReturnType Type="Collection(Edm.Int32)" />
      </Function>
      <Function Name="NeedsParam" IsBound="true">
        <Parameter Name="it" Type="N.A" />
        <Parameter Name="required" Type="Edm.String" />
        <ReturnType Type="N.C" />
      </Function>
      <Function Name="Sup" IsBound="true">
        <Parameter Name="it" Type="N.A" />
        <Parameter Name="a" Type="Edm.String" />
        <Parameter Name="b" Type="Edm.String" />
        <ReturnType Type="N.C" />
      </Function>
      <Function Name="Sup" IsBound="true">
        <Parameter Name="it" Type="N.A" />
        <Parameter Name="a" Type="Edm.Int32" />
        <ReturnType Type="N.C" />
      </Function>
      <Function Name="BT" IsBound="true">
        <Parameter Name="it" Type="N.D" />
        <Parameter Name="factor" Type="Edm.String" />
        <ReturnType Type="N.C" />
      </Function>
      <Function Name="BT" IsBound="true">
        <Parameter Name="it" Type="N.A" />
        <Parameter Name="factor" Type="Edm.Int32" />
        <ReturnType Type="N.C" />
      </Function>
      <Function Name="Z" IsBound="true">
        <Parameter Name="it" Type="N.A" />
        <Parameter Name="x" Type="Edm.Int32" />
        <ReturnType Type="N.C" />
      </Function>
      <Function Name="Z" IsBound="true">
        <Parameter Name="it" Type="N.A" />
        <ReturnType Type="N.C" />
      </Function>
      <Function Name="Tie" IsBound="true">
        <Parameter Name="it" Type="N.A" />
        <Parameter Name="factor" Type="Edm.String" />
        <ReturnType Type="N.C" />
      </Function>
      <Function Name="Tie" IsBound="true">
        <Parameter Name="it" Type="N.Derived" />
        <Parameter Name="factor" Type="Edm.Int32" />
        <ReturnType Type="N.C" />
      </Function>
      <Function Name="Pick" IsBound="true">
        <Parameter Name="it" Type="N.A" />
        <ReturnType Type="N.C" />
      </Function>
      <Function Name="Pick" IsBound="true">
        <Parameter Name="it" Type="N.Derived" />
        <Parameter Name="x" Type="Edm.Int32" />
        <ReturnType Type="N.C" />
      </Function>
      <Function Name="Amb" IsBound="true">
        <Parameter Name="it" Type="N.A" />
        <Parameter Name="a" Type="Edm.Int32" />
        <Parameter Name="b" Type="Edm.Int32" />
        <ReturnType Type="N.C" />
      </Function>
      <Function Name="Amb" IsBound="true">
        <Parameter Name="it" Type="N.A" />
        <Parameter Name="a" Type="Edm.Int32" />
        <Parameter Name="c" Type="Edm.Int32" />
        <ReturnType Type="N.C" />
      </Function>
      <Function Name="AnyEntity" IsBound="true">
        <Parameter Name="it" Type="N.A" />
        <ReturnType Type="Edm.EntityType" />
      </Function>
      <Function Name="AnyComplex" IsBound="true">
        <Parameter Name="it" Type="N.A" />
        <ReturnType Type="Edm.ComplexType" />
      </Function>
      <Function Name="AnyEntities" IsBound="true">
        <Parameter Name="it" Type="N.A" />
        <ReturnType Type="Collection(Edm.EntityType)" />
      </Function>
      <Function Name="Mixed" IsBound="true">
        <Parameter Name="it" Type="N.A" />
        <ReturnType Type="N.C" />
      </Function>
      <Function Name="Mixed" IsBound="true">
        <Parameter Name="it" Type="Edm.EntityType" />
        <ReturnType Type="Edm.String" />
      </Function>
      <Function Name="Missing" IsBound="true">
        <Parameter Name="it" Type="N.A" />
        <ReturnType Type="N.Missing" />
      </Function>
      <Function Name="Sum" IsBound="true">
        <Parameter Name="it" Type="N.A" />
        <Parameter Name="vals" Type="Collection(Edm.Int32)" />
        <ReturnType Type="Edm.Int32" />
      </Function>
      <Function Name="OneAddr" IsBound="true">
        <Parameter Name="it" Type="N.A" />
        <ReturnType Type="N.Addr" />
      </Function>
      <Function Name="ManyAddr" IsBound="true">
        <Parameter Name="it" Type="N.A" />
        <ReturnType Type="Collection(N.Addr)" />
      </Function>
      <Function Name="NoReturn" IsBound="true">
        <Parameter Name="it" Type="N.A" />
      </Function>
      <Action Name="BAct" IsBound="true">
        <Parameter Name="it" Type="N.D" />
        <Parameter Name="factor" Type="Edm.String" />
      </Action>
      <Action Name="BAct" IsBound="true">
        <Parameter Name="it" Type="N.A" />
        <Parameter Name="factor" Type="Edm.Int32" />
      </Action>
      <Action Name="AAmb" IsBound="true">
        <Parameter Name="it" Type="N.A" />
        <Parameter Name="a" Type="Edm.Int32" />
        <Parameter Name="b" Type="Edm.Int32" />
      </Action>
      <Action Name="AAmb" IsBound="true">
        <Parameter Name="it" Type="N.A" />
        <Parameter Name="a" Type="Edm.Int32" />
        <Parameter Name="c" Type="Edm.Int32" />
      </Action>
      <EntityContainer Name="C1">
        <EntitySet Name="As" EntityType="N.A" />
        <EntitySet Name="Cs" EntityType="N.C" />
        <EntitySet Name="Deriveds" EntityType="N.Derived" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

async function boundCompositionHandler() {
  const { parseCSDL } = await import('@odata-visualizer/shared');
  const store = createMetadataStore();
  store.set(await parseCSDL(boundCompositionCSDL), { sourceName: 'bound.xml', sourceType: 'file' });
  return createToolHandler(store, { allowLoadMetadata: false });
}

describe('bound function composition', () => {
  function emittedUrl(text: string): string {
    const line = text.split('\n').find((l) => l.startsWith('GET ') || l.startsWith('POST '));
    return (line ?? '').replace(/^(GET|POST) /, '');
  }

  it('composes a collection-bound function on the collection without keys', async () => {
    const handler = await boundCompositionHandler();
    const result = await handler('build_function_invocation', {
      functionName: 'AllOf',
      entitySet: 'As',
    });

    expect(result.isError).toBeUndefined();
    expect(emittedUrl(textOf(result))).toBe('<serviceRoot>/As/N.AllOf');
  });

  it('ignores keys supplied for a collection-bound function', async () => {
    const handler = await boundCompositionHandler();
    const result = await handler('build_function_invocation', {
      functionName: 'AllOf',
      entitySet: 'As',
      keys: { Id: '1' },
    });

    expect(result.isError).toBeUndefined();
    expect(emittedUrl(textOf(result))).toBe('<serviceRoot>/As/N.AllOf');
  });

  it('sketches a collection-bound invocation without a key predicate', async () => {
    const handler = await boundCompositionHandler();
    const details = await handler('get_function_details', { name: 'AllOf' });

    expect(details.isError).toBeUndefined();
    expect(textOf(details)).toContain('<serviceRoot>/As/N.AllOf');
    expect(textOf(details)).not.toContain('<key>');
  });

  it('selects the overload whose declared parameters cover the supplied names', async () => {
    const handler = await boundCompositionHandler();
    const result = await handler('build_function_invocation', {
      functionName: 'B',
      entitySet: 'As',
      keys: { Id: '1' },
      parameters: { factor: 2 },
    });

    expect(result.isError).toBeUndefined();
    expect(emittedUrl(textOf(result))).toBe("<serviceRoot>/As('1')/N.B(factor=2)");
  });

  it('lists the overloads when none accepts the supplied parameters', async () => {
    const handler = await boundCompositionHandler();
    const result = await handler('build_function_invocation', {
      functionName: 'B',
      entitySet: 'As',
      keys: { Id: '1' },
      parameters: { bogus: 1 },
    });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('No overload of "B"');
    expect(text).toContain('N.B(it)');
    expect(text).toContain('N.B(it, factor)');
  });

  it('warns when a declared parameter is omitted', async () => {
    const handler = await boundCompositionHandler();
    const result = await handler('build_function_invocation', {
      functionName: 'NeedsParam',
      entitySet: 'As',
      keys: { Id: '1' },
    });

    expect(result.isError).toBeUndefined();
    expect(emittedUrl(textOf(result))).toBe("<serviceRoot>/As('1')/N.NeedsParam");
    expect(textOf(result)).toContain('"required"');
    expect(textOf(result)).toContain('was not supplied');
  });

  it('drops query options that do not apply to a scalar return', async () => {
    const handler = await boundCompositionHandler();
    const result = await handler('build_function_invocation', {
      functionName: 'Count',
      entitySet: 'As',
      keys: { Id: '1' },
      select: ['Id'],
      top: 3,
    });

    expect(result.isError).toBeUndefined();
    expect(emittedUrl(textOf(result))).toBe("<serviceRoot>/As('1')/N.Count");
    const text = textOf(result);
    expect(text).toContain('$select');
    expect(text).toContain('$top');
    expect(text).toContain('not applicable');
    expect(text).toContain('Edm.Int32');
  });

  it('keeps $top on a collection of primitives and warns about $select', async () => {
    const handler = await boundCompositionHandler();
    const result = await handler('build_function_invocation', {
      functionName: 'Numbers',
      entitySet: 'As',
      keys: { Id: '1' },
      select: ['Id'],
      top: 3,
    });

    expect(result.isError).toBeUndefined();
    expect(emittedUrl(textOf(result))).toBe("<serviceRoot>/As('1')/N.Numbers()?$top=3");
    expect(textOf(result)).toContain('$select');
    expect(textOf(result)).toContain('not applicable');
  });
});

/**
 * #65: overload selection is by the most specific covering signature and by
 * the binding type the entity set exposes; a single-valued structured return
 * keeps only the options OData V4.01 Part 2 §5.1 allows on it.
 */
describe('bound overload specificity and return shapes', () => {
  function emittedUrl(text: string): string {
    const line = text.split('\n').find((l) => l.startsWith('GET ') || l.startsWith('POST '));
    return (line ?? '').replace(/^(GET|POST) /, '');
  }

  it('prefers the exact overload over a superset that covers it', async () => {
    const handler = await boundCompositionHandler();
    const result = await handler('build_function_invocation', {
      functionName: 'Sup',
      entitySet: 'As',
      keys: { Id: '1' },
      parameters: { a: 2 },
    });

    expect(result.isError).toBeUndefined();
    // The `(a, b)` overload covers `a`, but the `(a)` overload is exact, so
    // the false "b was not supplied" note must not appear.
    expect(emittedUrl(textOf(result))).toBe("<serviceRoot>/As('1')/N.Sup(a=2)");
    expect(textOf(result)).not.toContain('"b"');
  });

  it('types a literal by the exact overload, not the covering superset', async () => {
    const handler = await boundCompositionHandler();
    const result = await handler('build_function_invocation', {
      functionName: 'Sup',
      entitySet: 'As',
      keys: { Id: '1' },
      parameters: { a: 2 },
    });

    // The superset types `a` as Edm.String, which would render `a='2'`.
    expect(textOf(result)).toContain('N.Sup(a=2)');
    expect(textOf(result)).not.toContain("a='2'");
  });

  it('refuses an equal-specificity overload tie instead of picking one', async () => {
    const handler = await boundCompositionHandler();
    const result = await handler('build_function_invocation', {
      functionName: 'Amb',
      entitySet: 'As',
      keys: { Id: '1' },
      parameters: { a: 1 },
    });

    // `(it, a, b)` and `(it, a, c)` cover `a` at the same binding depth and
    // the same arity, so neither is more specific; picking either would emit
    // a false "not supplied" note for the parameter it does not declare.
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('Ambiguous');
    expect(text).toContain('N.Amb(it, a, b)');
    expect(text).toContain('N.Amb(it, a, c)');
    expect(text).not.toContain('not supplied');
  });

  it('refuses an equal-specificity action tie too', async () => {
    const handler = await boundCompositionHandler();
    const result = await handler('build_action_invocation', {
      actionName: 'AAmb',
      entitySet: 'As',
      keys: { Id: '1' },
      parameters: { a: 1 },
    });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('Ambiguous');
    expect(text).toContain('N.AAmb(it, a, b)');
    expect(text).toContain('N.AAmb(it, a, c)');
    expect(text).not.toContain('not supplied');
  });

  it('prefers the overload bound to the most derived type', async () => {
    const handler = await boundCompositionHandler();
    const result = await handler('build_function_invocation', {
      functionName: 'Tie',
      entitySet: 'Deriveds',
      keys: { Id: '1' },
      parameters: { factor: 2 },
    });

    // `Tie(N.A, Edm.String)` is declared first, but `Deriveds` exposes
    // N.Derived, so the N.Derived overload's Edm.Int32 must type the literal.
    expect(result.isError).toBeUndefined();
    expect(emittedUrl(textOf(result))).toBe("<serviceRoot>/Deriveds('1')/N.Tie(factor=2)");
    expect(textOf(result)).not.toContain("factor='2'");
  });

  it('prefers the exact parameter match across binding types', async () => {
    const handler = await boundCompositionHandler();
    const result = await handler('build_function_invocation', {
      functionName: 'Pick',
      entitySet: 'Deriveds',
      keys: { Id: '1' },
    });

    // `Pick(N.Derived, Edm.Int32)` is bound to the set's own type, but
    // `Pick(N.A)` exactly matches the supplied (empty) parameter set, and
    // "Function overload resolution" matches parameters before binding specificity breaks an arity
    // tie — so no false "x was not supplied" note.
    expect(result.isError).toBeUndefined();
    expect(emittedUrl(textOf(result))).toBe("<serviceRoot>/Deriveds('1')/N.Pick");
    expect(textOf(result)).not.toContain('"x"');
  });

  it('prefers a resolved binding type over an unresolvable one', async () => {
    const handler = await boundCompositionHandler();
    const result = await handler('build_function_invocation', {
      functionName: 'Mixed',
      entitySet: 'Deriveds',
      keys: { Id: '1' },
      select: ['Id'],
    });

    // `Mixed(Edm.EntityType)` cannot be resolved in the model, so it must rank
    // least derived rather than as the set's own type; otherwise it wins the
    // tie and its Edm.String return drops the caller's $select.
    expect(result.isError).toBeUndefined();
    expect(emittedUrl(textOf(result))).toBe("<serviceRoot>/Deriveds('1')/N.Mixed()?$select=Id");
    expect(textOf(result)).not.toContain('Edm.String');
  });

  it('filters overloads by the binding type of the entity set', async () => {
    const handler = await boundCompositionHandler();
    const result = await handler('build_function_invocation', {
      functionName: 'BT',
      entitySet: 'As',
      keys: { Id: '1' },
      parameters: { factor: 2 },
    });

    // `BT(N.D, Edm.String)` is declared first; `As` exposes N.A, whose
    // overload types factor as Edm.Int32.
    expect(result.isError).toBeUndefined();
    expect(emittedUrl(textOf(result))).toBe("<serviceRoot>/As('1')/N.BT(factor=2)");
  });

  it('filters action overloads by the binding type too', async () => {
    const handler = await boundCompositionHandler();
    const result = await handler('build_action_invocation', {
      actionName: 'BAct',
      entitySet: 'As',
      keys: { Id: '1' },
      parameters: { factor: '2' },
    });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('"factor": 2');
    expect(textOf(result)).not.toContain('"factor": "2"');
  });

  it('accepts a base-bound function on a derived entity set', async () => {
    const { parseCSDL } = await import('@odata-visualizer/shared');
    const csdl = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Base"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
      <EntityType Name="Derived" BaseType="N.Base" />
      <EntityType Name="C" />
      <Function Name="OnBase" IsBound="true">
        <Parameter Name="it" Type="N.Base" />
        <ReturnType Type="N.C" />
      </Function>
      <EntityContainer Name="C1"><EntitySet Name="Deriveds" EntityType="N.Derived" /></EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;
    const store = createMetadataStore();
    store.set(await parseCSDL(csdl), { sourceName: 'derived.xml', sourceType: 'file' });
    const handler = createToolHandler(store, { allowLoadMetadata: false });

    const result = await handler('build_function_invocation', {
      functionName: 'OnBase',
      entitySet: 'Deriveds',
      keys: { Id: '1' },
    });

    expect(result.isError).toBeUndefined();
    expect(emittedUrl(textOf(result))).toBe("<serviceRoot>/Deriveds('1')/N.OnBase");
  });

  it('selects the zero-parameter overload when no parameters are supplied', async () => {
    const handler = await boundCompositionHandler();
    const result = await handler('build_function_invocation', {
      functionName: 'Z',
      entitySet: 'As',
      keys: { Id: '1' },
    });

    expect(result.isError).toBeUndefined();
    expect(emittedUrl(textOf(result))).toBe("<serviceRoot>/As('1')/N.Z");
    expect(textOf(result)).not.toContain('"x"');
  });

  it('keeps only $select/$expand on a single complex return', async () => {
    const handler = await boundCompositionHandler();
    const result = await handler('build_function_invocation', {
      functionName: 'OneAddr',
      entitySet: 'As',
      keys: { Id: '1' },
      select: ['Street'],
      top: 3,
    });

    expect(result.isError).toBeUndefined();
    expect(emittedUrl(textOf(result))).toBe("<serviceRoot>/As('1')/N.OneAddr()?$select=Street");
    expect(textOf(result)).toContain('$top');
    expect(textOf(result)).toContain('not applicable');
  });

  it('drops paging from a single entity return too', async () => {
    const handler = await boundCompositionHandler();
    const result = await handler('build_function_invocation', {
      functionName: 'B',
      entitySet: 'As',
      keys: { Id: '1' },
      filters: [{ property: 'Id', operator: 'eq', value: '1' }],
      top: 3,
    });

    expect(result.isError).toBeUndefined();
    expect(emittedUrl(textOf(result))).toBe("<serviceRoot>/As('1')/N.B");
    expect(textOf(result)).toContain('$filter');
    expect(textOf(result)).toContain('$top');
    expect(textOf(result)).toContain('not applicable');
  });

  it('keeps $select and paging on a collection of complex values', async () => {
    const handler = await boundCompositionHandler();
    const result = await handler('build_function_invocation', {
      functionName: 'ManyAddr',
      entitySet: 'As',
      keys: { Id: '1' },
      select: ['Street'],
      top: 3,
    });

    expect(result.isError).toBeUndefined();
    expect(emittedUrl(textOf(result))).toBe(
      "<serviceRoot>/As('1')/N.ManyAddr()?$select=Street&$top=3",
    );
  });

  it('keeps paging on a collection of entities', async () => {
    const handler = await boundCompositionHandler();
    const result = await handler('build_function_invocation', {
      functionName: 'AllOf',
      entitySet: 'As',
      top: 3,
    });

    expect(result.isError).toBeUndefined();
    expect(emittedUrl(textOf(result))).toBe('<serviceRoot>/As/N.AllOf()?$top=3');
  });

  it('drops every option from a return that declares no type', async () => {
    const handler = await boundCompositionHandler();
    const result = await handler('build_function_invocation', {
      functionName: 'NoReturn',
      entitySet: 'As',
      keys: { Id: '1' },
      select: ['Id'],
      top: 3,
    });

    expect(result.isError).toBeUndefined();
    expect(emittedUrl(textOf(result))).toBe("<serviceRoot>/As('1')/N.NoReturn");
    expect(textOf(result)).toContain('$select');
    expect(textOf(result)).toContain('$top');
    expect(textOf(result)).toContain('not applicable');
  });

  it('keeps $select and $expand on an Edm.EntityType return', async () => {
    const handler = await boundCompositionHandler();
    const result = await handler('build_function_invocation', {
      functionName: 'AnyEntity',
      entitySet: 'As',
      keys: { Id: '1' },
      select: ['Id'],
      expand: [{ navProperty: 'Related' }],
      top: 3,
    });

    // Edm.EntityType is an abstract structured type, so §5.1 allows $select
    // and $expand on it; only the paging option is not applicable to a single
    // value.
    expect(result.isError).toBeUndefined();
    expect(emittedUrl(textOf(result))).toBe(
      "<serviceRoot>/As('1')/N.AnyEntity()?$select=Id&$expand=Related",
    );
    expect(textOf(result)).toContain('$top');
    expect(textOf(result)).toContain('not applicable');
  });

  it('keeps $select on an Edm.ComplexType return', async () => {
    const handler = await boundCompositionHandler();
    const result = await handler('build_function_invocation', {
      functionName: 'AnyComplex',
      entitySet: 'As',
      keys: { Id: '1' },
      select: ['Street'],
    });

    expect(result.isError).toBeUndefined();
    expect(emittedUrl(textOf(result))).toBe("<serviceRoot>/As('1')/N.AnyComplex()?$select=Street");
  });

  it('keeps $select and paging on a Collection(Edm.EntityType) return', async () => {
    const handler = await boundCompositionHandler();
    const result = await handler('build_function_invocation', {
      functionName: 'AnyEntities',
      entitySet: 'As',
      keys: { Id: '1' },
      select: ['Id'],
      top: 3,
    });

    expect(result.isError).toBeUndefined();
    expect(emittedUrl(textOf(result))).toBe(
      "<serviceRoot>/As('1')/N.AnyEntities()?$select=Id&$top=3",
    );
  });

  it('drops structured options from a return type that does not resolve', async () => {
    const handler = await boundCompositionHandler();
    const result = await handler('build_function_invocation', {
      functionName: 'Missing',
      entitySet: 'As',
      keys: { Id: '1' },
      select: ['Street'],
      top: 3,
    });

    // `N.Missing` is not declared, so nothing proves it can carry
    // $select/$expand and both options must be dropped with a note — emitting
    // `$select=Street` would compose a URL the service is expected to reject.
    expect(result.isError).toBeUndefined();
    expect(emittedUrl(textOf(result))).toBe("<serviceRoot>/As('1')/N.Missing");
    expect(textOf(result)).toContain('$select');
    expect(textOf(result)).toContain('$top');
    expect(textOf(result)).toContain('not applicable');
  });

  it('types a collection-valued function parameter element by element', async () => {
    const handler = await boundCompositionHandler();
    const result = await handler('build_function_invocation', {
      functionName: 'Sum',
      entitySet: 'As',
      keys: { Id: '1' },
      parameters: { vals: [1, 2] },
    });

    // Unwrapping `Collection(...)` is what types each element as Edm.Int32;
    // without it the array is quoted as an unknown-typed literal instead.
    expect(result.isError).toBeUndefined();
    expect(emittedUrl(textOf(result))).toBe("<serviceRoot>/As('1')/N.Sum(vals=1,2)");
    expect(textOf(result)).not.toContain("Collection(Edm.Int32)'");
  });

  it('refuses a collection-bound function on an entity set of another type', async () => {
    const handler = await boundCompositionHandler();
    const result = await handler('build_function_invocation', {
      functionName: 'AllOf',
      entitySet: 'Cs',
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('is bound to entity set "Cs"');
    expect(textOf(result)).toContain('N.AllOf(it)');
  });

  it('refuses a keyed invocation on an entity set of another type', async () => {
    const handler = await boundCompositionHandler();
    const result = await handler('build_function_invocation', {
      functionName: 'B',
      entitySet: 'Cs',
      keys: { Id: '1' },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('is bound to entity set "Cs"');
  });

  it('lists the overloads when the binding filter leaves one that does not cover', async () => {
    const handler = await boundCompositionHandler();
    const result = await handler('build_function_invocation', {
      functionName: 'BT',
      entitySet: 'As',
      keys: { Id: '1' },
      parameters: { bogus: 1 },
    });

    // The N.D-bound overload is filtered out, but `bogus` fits neither, so
    // the overload listing is more useful than "Unknown parameter".
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('No overload of "BT"');
    expect(text).toContain('N.BT(it, factor)');
    expect(text).not.toContain('Unknown parameter');
  });

  it('lists the action overloads when the binding filter leaves one that does not cover', async () => {
    const handler = await boundCompositionHandler();
    const result = await handler('build_action_invocation', {
      actionName: 'BAct',
      entitySet: 'As',
      keys: { Id: '1' },
      parameters: { bogus: 1 },
    });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('No overload of "BAct"');
    expect(text).toContain('N.BAct(it, factor)');
    expect(text).not.toContain('Unknown parameter');
  });

  it('lists every function overload in get_function_details', async () => {
    const handler = await boundCompositionHandler();
    const details = await handler('get_function_details', { name: 'B' });
    const text = textOf(details);

    expect(text).toContain('Overload 1 of 2');
    expect(text).toContain('Overload 2 of 2');
    expect(text).toContain('it: N.A (binding)');
    expect(text).toContain('factor: Edm.Int32');
  });

  it('lists every action overload in get_action_details', async () => {
    const handler = await boundCompositionHandler();
    const details = await handler('get_action_details', { name: 'BAct' });
    const text = textOf(details);

    expect(text).toContain('Overload 1 of 2');
    expect(text).toContain('Overload 2 of 2');
    expect(text).toContain('factor: Edm.String');
    expect(text).toContain('factor: Edm.Int32');
  });

  it('notes that keys are ignored for a collection-bound function', async () => {
    const handler = await boundCompositionHandler();
    const result = await handler('build_function_invocation', {
      functionName: 'AllOf',
      entitySet: 'As',
      keys: { Id: '1' },
    });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('keys');
    expect(textOf(result)).toContain('ignored');
  });

  it('reads the binding parameter by flag, not by position', async () => {
    const { parseCSDL } = await import('@odata-visualizer/shared');
    const metadata = await parseCSDL(boundCompositionCSDL);
    const fn = metadata.functions.find((f) => f.name === 'NeedsParam')!;
    // The parser only ever flags index 0; reordering pins the flag contract
    // the invocation builder already honours.
    fn.parameters = [fn.parameters[1], { ...fn.parameters[0], isBinding: true }];
    const store = createMetadataStore();
    store.set(metadata, { sourceName: 'swapped.xml', sourceType: 'file' });
    const handler = createToolHandler(store, { allowLoadMetadata: false });

    const details = await handler('get_function_details', { name: 'NeedsParam' });

    expect(details.isError).toBeUndefined();
    expect(textOf(details)).toContain('<serviceRoot>/As(Id=<Id>)/N.NeedsParam');
  });
});

/**
 * `get_relationships` joins the operation edges whole, so a model with more
 * bound functions than `limit` ignored the page size entirely.
 */
describe('operation edge pagination', () => {
  it('paginates the Operation edges section', async () => {
    const { parseCSDL } = await import('@odata-visualizer/shared');
    const functions = Array.from(
      { length: 60 },
      (_, i) =>
        `<Function Name="F${i}" IsBound="true"><Parameter Name="it" Type="N.A" /><ReturnType Type="N.C" /></Function>`,
    ).join('');
    const csdl = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="A"><Key><PropertyRef Name="Id" /></Key><Property Name="Id" Type="Edm.Int32" Nullable="false" /></EntityType>
      <EntityType Name="C"><Key><PropertyRef Name="Id" /></Key><Property Name="Id" Type="Edm.Int32" Nullable="false" /></EntityType>
      ${functions}
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

    const store = createMetadataStore();
    store.set(await parseCSDL(csdl), { sourceName: 'many.xml' });
    const handler = createToolHandler(store, { allowLoadMetadata: false });

    const result = await handler('get_relationships', { entityName: 'A', limit: 5 });
    const text = textOf(result);

    expect(text).toContain('Operation edges:');
    expect(text).toContain('Showing 1-5 of 60. Use limit/offset for more.');
    expect(text.match(/N\.F\d+\(\):/g)).toHaveLength(5);
  });
});
