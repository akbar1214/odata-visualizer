import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCSDL } from '../src/parser.js';
import {
  findEntitiesByName,
  getEffectiveKeys,
  getEffectiveProperties,
  getEffectiveNavigationProperties,
  resolveInheritanceChain,
} from '../src/resolve.js';

const windchillCSDL = readFileSync(
  fileURLToPath(new URL('./fixtures/windchill-prodmgmt.xml', import.meta.url)),
  'utf-8',
);

describe('XML Parser', () => {
  const minimalCSDL = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="TestService.Models" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Product">
        <Key>
          <PropertyRef Name="Id" />
        </Key>
        <Property Name="Id" Type="Edm.Int32" Nullable="false" />
        <Property Name="Name" Type="Edm.String" />
        <Property Name="Price" Type="Edm.Decimal" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

  it('should parse minimal CSDL with one entity', async () => {
    const result = await parseCSDL(minimalCSDL);

    expect(result).toBeDefined();
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].name).toBe('Product');
  });

  it('should extract entity properties', async () => {
    const result = await parseCSDL(minimalCSDL);
    const product = result.entities[0];

    expect(product.properties).toHaveLength(3);
    expect(product.properties[0].name).toBe('Id');
    expect(product.properties[0].type).toBe('Edm.Int32');
    expect(product.properties[0].nullable).toBe(false);
  });

  it('should identify key properties', async () => {
    const result = await parseCSDL(minimalCSDL);
    const product = result.entities[0];

    expect(product.keys).toContain('Id');
    expect(product.properties[0].isKey).toBe(true);
  });

  it('should handle nullable properties', async () => {
    const result = await parseCSDL(minimalCSDL);
    const product = result.entities[0];

    const nameProp = product.properties.find((p) => p.name === 'Name');
    expect(nameProp?.nullable).toBe(true);
  });

  const csdlWithRelationships = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="TestService.Models" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Order">
        <Key>
          <PropertyRef Name="Id" />
        </Key>
        <Property Name="Id" Type="Edm.Int32" Nullable="false" />
        <NavigationProperty Name="Customer" Type="TestService.Models.Customer" />
      </EntityType>
      <EntityType Name="Customer">
        <Key>
          <PropertyRef Name="Id" />
        </Key>
        <Property Name="Id" Type="Edm.Int32" Nullable="false" />
        <NavigationProperty Name="Orders" Type="Collection(TestService.Models.Order)" />
      </EntityType>
      <Association Name="Order_Customer">
        <End Type="TestService.Models.Order" Role="Order" Multiplicity="1" />
        <End Type="TestService.Models.Customer" Role="Customer" Multiplicity="*" />
      </Association>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

  it('should parse entities with relationships', async () => {
    const result = await parseCSDL(csdlWithRelationships);

    expect(result.entities).toHaveLength(2);
    expect(result.relationships).toHaveLength(1);
  });

  it('should extract navigation properties', async () => {
    const result = await parseCSDL(csdlWithRelationships);
    const order = result.entities.find((e) => e.name === 'Order');

    expect(order?.navigationProperties).toHaveLength(1);
    expect(order?.navigationProperties[0].name).toBe('Customer');
  });

  it('should parse association ends', async () => {
    const result = await parseCSDL(csdlWithRelationships);
    const rel = result.relationships[0];

    expect(rel.name).toBe('Order_Customer');
    expect(rel.from.entity).toBe('Order');
    expect(rel.from.multiplicity).toBe('1');
    expect(rel.to.entity).toBe('Customer');
    expect(rel.to.multiplicity).toBe('*');
  });

  it('should derive V4 relationships from navigation properties', async () => {
    const result = await parseCSDL(csdlWithRelationships);
    const order = result.entities.find((e) => e.name === 'Order');
    const nav = order?.navigationProperties[0];

    expect(nav?.targetType).toBe('Customer');
  });

  it('should handle empty/invalid XML gracefully', async () => {
    await expect(parseCSDL('')).rejects.toThrow();
    await expect(parseCSDL('invalid xml')).rejects.toThrow();
  });

  it('should handle CSDL without entities', async () => {
    const emptyCSDL = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="EmptyService.Models" xmlns="http://docs.oasis-open.org/odata/ns/edm">
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

    const result = await parseCSDL(emptyCSDL);
    expect(result.entities).toHaveLength(0);
  });

  const csdlWithComplexTypes = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="TestService.Models" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <ComplexType Name="Address">
        <Property Name="Street" Type="Edm.String" />
        <Property Name="City" Type="Edm.String" />
        <Property Name="ZipCode" Type="Edm.String" />
      </ComplexType>
      <EntityType Name="Person">
        <Key>
          <PropertyRef Name="Id" />
        </Key>
        <Property Name="Id" Type="Edm.Int32" Nullable="false" />
        <Property Name="Name" Type="Edm.String" />
        <Property Name="Address" Type="TestService.Models.Address" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

  it('should parse complex types', async () => {
    const result = await parseCSDL(csdlWithComplexTypes);

    expect(result.entities).toHaveLength(2);
    const address = result.entities.find((e) => e.name === 'Address');
    expect(address).toBeDefined();
    expect(address?.properties).toHaveLength(3);
  });

  const csdlWithMultipleNamespaces = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="ServiceA.Models" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Product">
        <Key>
          <PropertyRef Name="Id" />
        </Key>
        <Property Name="Id" Type="Edm.Int32" Nullable="false" />
      </EntityType>
    </Schema>
    <Schema Namespace="ServiceB.Models" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Category">
        <Key>
          <PropertyRef Name="Id" />
        </Key>
        <Property Name="Id" Type="Edm.Int32" Nullable="false" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

  it('should handle multiple schemas/namespaces', async () => {
    const result = await parseCSDL(csdlWithMultipleNamespaces);

    expect(result.entities).toHaveLength(2);
    expect(result.entities[0].namespace).toBe('ServiceA.Models');
    expect(result.entities[1].namespace).toBe('ServiceB.Models');
  });

  const csdlWithEntityContainer = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Demo.Models" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Product">
        <Key>
          <PropertyRef Name="Id" />
        </Key>
        <Property Name="Id" Type="Edm.Int32" Nullable="false" />
        <NavigationProperty Name="Category" Type="Demo.Models.Category" />
      </EntityType>
      <EntityType Name="Category">
        <Key>
          <PropertyRef Name="Id" />
        </Key>
        <Property Name="Id" Type="Edm.Int32" Nullable="false" />
      </EntityType>
      <Action Name="ResetData" />
      <EntityContainer Name="DemoContainer">
        <EntitySet Name="Products" EntityType="Demo.Models.Product" />
        <EntitySet Name="Categories" EntityType="Demo.Models.Category" />
        <ActionImport Name="Reset" Action="Demo.Models.ResetData" EntitySet="Products" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

  it('should parse entity containers and entity sets', async () => {
    const result = await parseCSDL(csdlWithEntityContainer);

    expect(result.entityContainers).toHaveLength(1);
    const container = result.entityContainers[0];
    expect(container.name).toBe('DemoContainer');
    expect(container.entitySets).toHaveLength(2);
    expect(container.entitySets[0].name).toBe('Products');
    expect(container.entitySets[0].entityType).toBe('Product');
  });

  it('should parse action imports', async () => {
    const result = await parseCSDL(csdlWithEntityContainer);

    expect(result.actionImports).toHaveLength(1);
    expect(result.actionImports[0].name).toBe('Reset');
    expect(result.actionImports[0].actionName).toBe('ResetData');
    expect(result.actionImports[0].entitySet).toBe('Products');
  });

  it('should derive relationships from V4 navigation properties without Associations', async () => {
    const result = await parseCSDL(csdlWithEntityContainer);

    expect(result.relationships).toHaveLength(1);
    const rel = result.relationships[0];
    expect(rel.from.entity).toBe('Product');
    expect(rel.to.entity).toBe('Category');
    expect(rel.from.multiplicity).toBe('1');
    expect(rel.to.multiplicity).toBe('*');
  });

  const csdlWithCollectionNav = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Demo.Models" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Customer">
        <Key>
          <PropertyRef Name="Id" />
        </Key>
        <Property Name="Id" Type="Edm.Int32" Nullable="false" />
        <NavigationProperty Name="Orders" Type="Collection(Demo.Models.Order)" />
      </EntityType>
      <EntityType Name="Order">
        <Key>
          <PropertyRef Name="Id" />
        </Key>
        <Property Name="Id" Type="Edm.Int32" Nullable="false" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

  it('should set multiplicity for collection navigation properties', async () => {
    const result = await parseCSDL(csdlWithCollectionNav);

    expect(result.relationships).toHaveLength(1);
    const rel = result.relationships[0];
    expect(rel.from.entity).toBe('Customer');
    expect(rel.to.entity).toBe('Order');
    expect(rel.from.multiplicity).toBe('*');
    expect(rel.to.multiplicity).toBe('1');
  });
});

describe('Windchill-like CSDL', () => {
  it('parses version strings verbatim', async () => {
    const result = await parseCSDL(windchillCSDL);
    expect(result.version).toBe('4.01');
    expect(result.dataServicesVersion).toBe('4.0');
  });

  it('parses enum types with members', async () => {
    const result = await parseCSDL(windchillCSDL);
    const state = result.enumTypes.find((e) => e.name === 'LifeCycleState');
    expect(state).toBeDefined();
    expect(state?.qualifiedName).toBe('PTC.ProdMgmt.LifeCycleState');
    expect(state?.underlyingType).toBe('Edm.String');
    expect(state?.members.map((m) => m.name)).toEqual(['INWORK', 'RELEASED', 'OBSOLETE']);
    expect(state?.members[0].value).toBe('0');
  });

  it('parses type definitions', async () => {
    const result = await parseCSDL(windchillCSDL);
    const partNumber = result.typeDefinitions.find((t) => t.name === 'PartNumber');
    expect(partNumber?.underlyingType).toBe('Edm.String');
    expect(partNumber?.qualifiedName).toBe('PTC.ProdMgmt.PartNumber');
  });

  it('parses schema-level actions with parameters, binding, and return types', async () => {
    const result = await parseCSDL(windchillCSDL);
    const getStructure = result.actions.find((a) => a.name === 'GetPartStructure');
    expect(getStructure).toBeDefined();
    expect(getStructure?.isBound).toBe(true);
    expect(getStructure?.parameters).toHaveLength(3);
    expect(getStructure?.parameters[0]).toMatchObject({
      name: 'Part',
      type: 'PTC.ProdMgmt.Part',
      isBinding: true,
    });
    expect(getStructure?.returnType).toBe('Collection(PTC.ProdMgmt.PartStructureItem)');
    expect(getStructure?.annotations?.['Core.Description']).toContain('part structure');

    const unbound = result.actions.find((a) => a.name === 'CreateParts');
    expect(unbound?.isBound).toBe(false);
    expect(unbound?.parameters[0].type).toBe('Collection(Edm.String)');
  });

  it('links action imports to action definitions', async () => {
    const result = await parseCSDL(windchillCSDL);
    const createImport = result.actionImports.find((a) => a.name === 'CreateParts');
    expect(createImport).toBeDefined();
    expect(createImport?.actionName).toBe('CreateParts');
    expect(createImport?.qualifiedActionName).toBe('PTC.ProdMgmt.CreateParts');
    expect(createImport?.parameter?.map((p) => p.name)).toEqual(['PartNames', 'View']);
    expect(createImport?.returnType).toBe('Collection(PTC.ProdMgmt.Part)');

    const boundImport = result.actionImports.find((a) => a.name === 'ResetFilters');
    expect(boundImport?.parameter?.map((p) => p.name)).toEqual(['IncludeChildren']);
  });

  it('parses functions with parameters and return types', async () => {
    const result = await parseCSDL(windchillCSDL);
    const metaInfo = result.functions.find((f) => f.name === 'GetWindchillMetaInfo');
    expect(metaInfo?.isBound).toBe(false);
    expect(metaInfo?.parameters.map((p) => p.name)).toEqual([
      'EntityName',
      'IncludeAncestorProperty',
    ]);
    expect(metaInfo?.returnType).toBe('Collection(PTC.ProdMgmt.EntityMetaInfo)');

    const import_ = result.functionImports.find((f) => f.name === 'GetWindchillMetaInfo');
    expect(import_?.returnType).toBe('Collection(PTC.ProdMgmt.EntityMetaInfo)');
    expect(import_?.parameter).toHaveLength(2);

    const boundFunc = result.functions.find((f) => f.name === 'GetPartEstimate');
    expect(boundFunc?.isBound).toBe(true);
    expect(boundFunc?.parameters[0].isBinding).toBe(true);
    expect(boundFunc?.returnType).toBe('Edm.Decimal');
  });

  it('parses element-level annotations and labels', async () => {
    const result = await parseCSDL(windchillCSDL);
    const part = result.entities.find((e) => e.name === 'Part');
    expect(part?.annotations?.['PTC.Operations']).toContain('CREATE');
    expect(part?.label).toBe('A product structure part');

    const description = part?.properties.find((p) => p.name === 'description' ||
      result.entities.find((e) => e.name === 'WindchillEntity')?.properties.find((p) => p.name === 'description'));
    // description lives on the base type
    const base = result.entities.find((e) => e.name === 'WindchillEntity');
    const descProp = base?.properties.find((p) => p.name === 'description');
    expect(descProp?.label).toBe('User-visible description');
    expect(descProp?.annotations?.['Core.Description']).toBe('User-visible description');
    expect(description).toBeDefined();

    const checkedOut = result.entities
      .find((e) => e.name === 'CADDocument')
      ?.properties.find((p) => p.name === 'checkedOutBy');
    expect(checkedOut?.annotations?.['PTC.UpdateableViaAction']).toBe('CheckInOut');
  });

  it('parses navigation property bindings and entity set flags', async () => {
    const result = await parseCSDL(windchillCSDL);
    const parts = result.entityContainers
      .find((c) => c.name === 'ProdMgmtContainer')
      ?.entitySets.find((s) => s.name === 'Parts');
    expect(parts?.entityTypeQualified).toBe('PTC.ProdMgmt.Part');
    expect(parts?.creatable).toBe(true);
    expect(parts?.deletable).toBe(true);
    expect(parts?.navigationPropertyBindings).toEqual([
      { path: 'Documents', target: 'CADDocuments' },
      { path: 'SourcePart', target: 'Parts' },
    ]);
    expect(parts?.annotations?.['Core.Description']).toBe('All Windchill parts');
  });

  it('marks entity vs complex kind', async () => {
    const result = await parseCSDL(windchillCSDL);
    expect(result.entities.find((e) => e.name === 'Part')?.kind).toBe('entity');
    expect(result.entities.find((e) => e.name === 'Quantity')?.kind).toBe('complex');
    expect(result.entities.find((e) => e.name === 'WindchillEntity')?.kind).toBe('entity');
  });

  it('does not produce NaN for MaxLength="Max"', async () => {
    const result = await parseCSDL(windchillCSDL);
    const base = result.entities.find((e) => e.name === 'WindchillEntity');
    const nameProp = base?.properties.find((p) => p.name === 'name');
    expect(nameProp?.maxLength).toBeUndefined();
    const descProp = base?.properties.find((p) => p.name === 'description');
    expect(descProp?.maxLength).toBe(1024);
  });

  it('keeps qualified names and resolves short-name collisions', async () => {
    const result = await parseCSDL(windchillCSDL);
    const matches = findEntitiesByName(result.entities, 'Part');
    expect(matches).toHaveLength(2);
    expect(matches.map((m) => m.qualifiedName).sort()).toEqual([
      'PTC.ProdMgmt.Part',
      'net.example.common.Part',
    ]);
    const exact = findEntitiesByName(result.entities, 'PTC.ProdMgmt.Part');
    expect(exact).toHaveLength(1);
  });

  it('resolves inheritance chains and effective properties', async () => {
    const result = await parseCSDL(windchillCSDL);
    const electrical = result.entities.find((e) => e.name === 'ElectricalPart');
    expect(electrical).toBeDefined();

    const chain = resolveInheritanceChain(electrical!, result.entities);
    expect(chain.map((e) => e.name)).toEqual(['ElectricalPart', 'Part', 'WindchillEntity']);

    const props = getEffectiveProperties(electrical!, result.entities);
    const propNames = props.map((p) => p.name);
    expect(propNames).toContain('ID');
    expect(propNames).toContain('number');
    expect(propNames).toContain('voltageRating');
    expect(props.find((p) => p.name === 'ID')?.sourceType).toBe('WindchillEntity');

    const navs = getEffectiveNavigationProperties(electrical!, result.entities);
    expect(navs.map((n) => n.name)).toEqual(['Documents', 'SourcePart']);
  });

  it('inherits keys from base types', async () => {
    const result = await parseCSDL(windchillCSDL);
    const part = result.entities.find((e) => e.name === 'Part');
    expect(part?.keys).toEqual(['ID']);
    expect(getEffectiveKeys(part!, result.entities)).toEqual(['ID']);

    const electrical = result.entities.find((e) => e.name === 'ElectricalPart');
    expect(electrical?.keys).toEqual(['ID']);
  });

  it('derives relationships from V4 navigation properties', async () => {
    const result = await parseCSDL(windchillCSDL);
    const rel = result.relationships.find(
      (r) => r.from.entity === 'Part' && r.to.entity === 'CADDocument',
    );
    expect(rel).toBeDefined();
    expect(rel?.name).toBe('Part_Documents');
  });
});
