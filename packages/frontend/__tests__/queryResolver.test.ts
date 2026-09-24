import { describe, it, expect } from 'vitest';
import { parseCSDL } from '@odata-visualizer/shared';
import {
  buildODataQuery,
  findEntity,
  formatODataValue,
  getDefaultQuery,
  getQueryableEntities,
  getResolvedEntity,
  getTargetEntityName,
  isComplexType,
} from '../src/utils/queryResolver';

const csdl = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Shop" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <ComplexType Name="Money">
        <Property Name="Amount" Type="Edm.Decimal" />
        <Property Name="Currency" Type="Edm.String" />
      </ComplexType>
      <EntityType Name="Base">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <Property Name="Created" Type="Edm.DateTimeOffset" />
      </EntityType>
      <EntityType Name="Order" BaseType="Shop.Base">
        <Property Name="Number" Type="Edm.String" />
        <Property Name="Total" Type="Edm.Decimal" />
        <NavigationProperty Name="Lines" Type="Collection(Shop.OrderLine)" />
      </EntityType>
      <EntityType Name="OrderLine">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <Property Name="Sku" Type="Edm.String" />
        <NavigationProperty Name="Order" Type="Shop.Order" />
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Orders" EntityType="Shop.Order" />
        <EntitySet Name="Lines" EntityType="Shop.OrderLine" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

async function loadModel() {
  return parseCSDL(csdl);
}

describe('formatODataValue', () => {
  it('emits V4 literals without V2/V3 prefixes', () => {
    expect(formatODataValue('3f2504e0-4f89-11d3-9a0c-0305e82c3301', 'Edm.Guid')).toBe(
      '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    );
    expect(formatODataValue('2024-01-15T10:00:00Z', 'Edm.DateTimeOffset')).toBe(
      '2024-01-15T10:00:00Z',
    );
    expect(formatODataValue("O'Brien", 'Edm.String')).toBe("'O''Brien'");
    expect(formatODataValue('42', 'Edm.Int32')).toBe('42');
    expect(formatODataValue('true', 'Edm.Boolean')).toBe('true');
  });

  it('never throws while the user is typing', () => {
    expect(formatODataValue('not-a-guid', 'Edm.Guid')).toBe("'not-a-guid'");
    expect(formatODataValue('', 'Edm.String')).toBe("''");
  });
});

describe('entity resolution', () => {
  it('finds entities by short and qualified name', async () => {
    const model = await loadModel();
    expect(findEntity('Order', model.entities)?.qualifiedName).toBe('Shop.Order');
    expect(findEntity('Shop.Order', model.entities)?.qualifiedName).toBe('Shop.Order');
    expect(findEntity('Nope', model.entities)).toBeUndefined();
  });

  it('resolves inherited properties', async () => {
    const model = await loadModel();
    const resolved = getResolvedEntity('Order', model.entities);
    expect(resolved?.allProperties.map((p) => p.name)).toEqual([
      'Id',
      'Created',
      'Number',
      'Total',
    ]);
  });

  it('resolves navigation targets to the short name used by the graph', async () => {
    const model = await loadModel();
    const order = findEntity('Order', model.entities)!;
    expect(getTargetEntityName('Lines', order, model)).toBe('OrderLine');
    expect(getTargetEntityName('Nope', order, model)).toBeUndefined();
  });
});

describe('isComplexType', () => {
  it('uses the parsed kind rather than guessing from keys', async () => {
    const model = await loadModel();
    expect(isComplexType(findEntity('Money', model.entities)!)).toBe(true);
    // Order inherits its key, so the old "no keys => complex" heuristic was wrong.
    expect(isComplexType(findEntity('Order', model.entities)!)).toBe(false);

    const queryable = getQueryableEntities(model.entities).map((e) => e.name);
    expect(queryable).toEqual(['Base', 'Order', 'OrderLine']);
  });
});

describe('buildODataQuery', () => {
  it('builds a V4 query from UI state', async () => {
    const model = await loadModel();
    const query = {
      ...getDefaultQuery('Order'),
      filters: [
        { property: 'Total', operator: 'gt', value: '100' },
        { property: 'Number', operator: 'contains', value: 'A&B' },
      ],
      select: ['Id', 'Number'],
      sort: 'Number',
      sortDirection: 'desc' as const,
      top: 10,
    };

    const url = buildODataQuery(query, model);
    expect(url).toContain('$filter=Total gt 100');
    expect(url).toContain("contains(Number,'A%26B')");
    expect(url).toContain('$select=Id,Number');
    expect(url).toContain('$orderby=Number desc');
    expect(url).toContain('$top=10');
  });

  it('builds nested expansions', async () => {
    const model = await loadModel();
    const query = {
      ...getDefaultQuery('Order'),
      expand: [
        {
          navProperty: 'Lines',
          select: ['Sku'],
          expand: [],
          filters: [{ property: 'Sku', operator: 'eq', value: 'X1' }],
          filterLogic: 'and' as const,
          sort: '',
          sortDirection: 'asc' as const,
          top: 0,
          skip: 0,
        },
      ],
    };

    expect(buildODataQuery(query, model)).toBe(
      "/Order?$expand=Lines($select=Sku;$filter=Sku eq 'X1')&$top=25",
    );
  });

  it('degrades gracefully for an unknown entity', async () => {
    const model = await loadModel();
    expect(buildODataQuery(getDefaultQuery('Nope'), model)).toBe('');
  });
});
