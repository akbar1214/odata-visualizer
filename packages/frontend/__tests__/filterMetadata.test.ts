import { describe, it, expect } from 'vitest';
import { parseCSDL } from '@odata-visualizer/shared';
import { filterMetadata } from '../src/utils/layout';

const csdl = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Shop" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <ComplexType Name="Money">
        <Property Name="Amount" Type="Edm.Decimal" />
      </ComplexType>
      <EntityType Name="Order">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="Lines" Type="Collection(Shop.OrderLine)" />
      </EntityType>
      <EntityType Name="OrderLine">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="Order" Type="Shop.Order" />
      </EntityType>
      <EntityType Name="Customer">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="Orders" Type="Collection(Shop.Order)" />
      </EntityType>
      <EntityType Name="Part" BaseType="Shop.Order">
        <Property Name="PartNumber" Type="Edm.String" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

async function load() {
  return parseCSDL(csdl);
}

describe('filterMetadata', () => {
  it('returns everything when no criteria are given', async () => {
    const metadata = await load();
    expect(filterMetadata(metadata, {}).entities).toHaveLength(metadata.entities.length);
  });

  it('keeps one-hop neighbours so relationships survive a search', async () => {
    const metadata = await load();
    // "OrderLine" matches exactly one type, but its relationship to Order
    // used to be dropped because the other endpoint was filtered out.
    const result = filterMetadata(metadata, { search: 'OrderLine' });

    expect(result.entities.map((e) => e.name).sort()).toEqual(['Order', 'OrderLine']);
    expect(result.relationships.map((r) => r.name)).toEqual(['Order_Lines']);
  });

  it('can be asked to exclude neighbours', async () => {
    const metadata = await load();
    const result = filterMetadata(metadata, {
      search: 'OrderLine',
      includeNeighbours: false,
    });
    expect(result.entities.map((e) => e.name)).toEqual(['OrderLine']);
    expect(result.relationships).toHaveLength(0);
  });

  it('finds types that navigate to a matching name', async () => {
    const metadata = await load();
    // Customer has an "Orders" navigation property, so it matches "order".
    const result = filterMetadata(metadata, { search: 'order' });
    expect(result.entities.map((e) => e.name).sort()).toEqual([
      'Customer',
      'Order',
      'OrderLine',
    ]);
    expect(result.relationships).toHaveLength(2);
  });

  it('excludes complex types by default', async () => {
    const metadata = await load();
    expect(filterMetadata(metadata, { search: 'Money' }).entities).toHaveLength(0);
    expect(
      filterMetadata(metadata, { search: 'Money', includeComplexTypes: true }).entities,
    ).toHaveLength(1);
  });

  it('matches inherited properties', async () => {
    const metadata = await load();
    const result = filterMetadata(metadata, { search: 'PartNumber' });
    expect(result.entities.map((e) => e.name)).toContain('Part');
  });

  it('ranks the exact match first when capping', async () => {
    const metadata = await load();
    const result = filterMetadata(metadata, { search: 'Order', maxEntities: 1 });
    expect(result.entities[0].name).toBe('Order');
  });

  it('filters by short or qualified entity name', async () => {
    const metadata = await load();
    expect(
      filterMetadata(metadata, { entityNames: ['Order'] }).entities.map((e) => e.name),
    ).toEqual(['Order']);
    expect(
      filterMetadata(metadata, { entityNames: ['Shop.Customer'] }).entities.map((e) => e.name),
    ).toEqual(['Customer']);
  });

  it('does not pull in neighbours when filtering by explicit names', async () => {
    const metadata = await load();
    const result = filterMetadata(metadata, { entityNames: ['Order'] });
    expect(result.entities.map((e) => e.name)).toEqual(['Order']);
  });
});
