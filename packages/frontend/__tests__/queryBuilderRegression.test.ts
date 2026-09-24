import { describe, it, expect } from 'vitest';
import { parseCSDL } from '@odata-visualizer/shared';
import { buildODataQuery, getDefaultQuery, getQueryableEntities } from '../src/utils/queryResolver';

const csdl = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Shop" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <ComplexType Name="Money"><Property Name="Amount" Type="Edm.Decimal" /></ComplexType>
      <EntityType Name="Base" Abstract="true">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.Int32" Nullable="false" />
        <Property Name="Created" Type="Edm.DateTimeOffset" />
      </EntityType>
      <EntityType Name="Order" BaseType="Shop.Base">
        <Property Name="Number" Type="Edm.String" />
        <Property Name="Total" Type="Edm.Decimal" />
        <Property Name="ShipDate" Type="Edm.Date" />
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Orders" EntityType="Shop.Order" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

async function model() {
  return parseCSDL(csdl);
}

describe('buildODataQuery resilience while editing', () => {
  it('keeps the rest of the query when a new filter has an empty value', async () => {
    const metadata = await model();
    // FilterBuilder adds a row with value: '' — a numeric property must not
    // make the whole preview collapse to /Order.
    const result = buildODataQuery(
      {
        ...getDefaultQuery('Order'),
        filters: [{ property: 'Total', operator: 'gt', value: '' }],
        select: ['Id', 'Number'],
        top: 10,
      },
      metadata,
    );

    expect(result).toContain('$select=Id,Number');
    expect(result).toContain('$top=10');
    expect(result).not.toBe('/Order');
  });

  it('keeps the rest of the query while a numeric value is half-typed', async () => {
    const metadata = await model();
    const result = buildODataQuery(
      {
        ...getDefaultQuery('Order'),
        filters: [{ property: 'Total', operator: 'gt', value: '10.' }],
        select: ['Number'],
      },
      metadata,
    );
    expect(result).toContain('$select=Number');
  });

  it('keeps the rest of the query while a date value is incomplete', async () => {
    const metadata = await model();
    const result = buildODataQuery(
      {
        ...getDefaultQuery('Order'),
        filters: [{ property: 'Created', operator: 'ge', value: '2024-01' }],
        top: 5,
      },
      metadata,
    );
    expect(result).toContain('$top=5');
  });

  it('still renders valid filters', async () => {
    const metadata = await model();
    const result = buildODataQuery(
      {
        ...getDefaultQuery('Order'),
        filters: [{ property: 'Total', operator: 'gt', value: '10' }],
      },
      metadata,
    );
    expect(result).toContain('$filter=Total gt 10');
  });

  it('quotes numeric-looking values on string properties', async () => {
    const metadata = await model();
    // The UI addresses the type name (/Order) rather than the entity set, so
    // literal typing must not depend on resolving an entity set. A part
    // number like "100" must stay a string.
    const result = buildODataQuery(
      {
        ...getDefaultQuery('Order'),
        filters: [{ property: 'Number', operator: 'eq', value: '100' }],
      },
      metadata,
    );
    expect(result).toContain("$filter=Number eq '100'");
  });

  it('emits bare dates for date properties', async () => {
    const metadata = await model();

    const dateTime = buildODataQuery(
      {
        ...getDefaultQuery('Order'),
        filters: [{ property: 'Created', operator: 'ge', value: '2024-01-15T00:00:00Z' }],
      },
      metadata,
    );
    expect(dateTime).toContain('$filter=Created ge 2024-01-15T00:00:00Z');

    const dateOnly = buildODataQuery(
      {
        ...getDefaultQuery('Order'),
        filters: [{ property: 'ShipDate', operator: 'eq', value: '2024-01-15' }],
      },
      metadata,
    );
    expect(dateOnly).toContain('$filter=ShipDate eq 2024-01-15');
    expect(dateOnly).not.toContain("datetime'");
  });

  it('omits an invalid literal but keeps the rest of the query', async () => {
    const metadata = await model();
    const result = buildODataQuery(
      {
        ...getDefaultQuery('Order'),
        filters: [
          { property: 'ShipDate', operator: 'eq', value: 'yesterday' },
          { property: 'Number', operator: 'eq', value: 'A-1' },
        ],
        select: ['Number'],
      },
      metadata,
    );
    expect(result).toContain("$filter=Number eq 'A-1'");
    expect(result).not.toContain('yesterday');
  });

  it('emits bare booleans and numbers for typed properties', async () => {
    const metadata = await model();
    const result = buildODataQuery(
      {
        ...getDefaultQuery('Order'),
        filters: [
          { property: 'Id', operator: 'eq', value: '7' },
          { property: 'Total', operator: 'lt', value: '99.5' },
        ],
      },
      metadata,
    );
    expect(result).toContain('Id eq 7');
    expect(result).toContain('Total lt 99.5');
  });
});

describe('getQueryableEntities', () => {
  it('excludes complex types and abstract entity types', async () => {
    const metadata = await model();
    const names = getQueryableEntities(metadata.entities).map((e) => e.name);
    // Money is complex, Base is abstract: neither can be queried directly.
    expect(names).toEqual(['Order']);
  });
});
