import { describe, it, expect } from 'vitest';
import { parseCSDL } from '@odata-visualizer/shared';
import { createEntitySearch, searchRelationships, tokenize } from '../src/utils/entitySearch';

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
        <Property Name="Description" Type="Edm.String">
          <Annotation Term="Core.Description" String="Shared identifier used by all shop types" />
        </Property>
      </EntityType>
      <EntityType Name="Order" BaseType="Shop.Base">
        <Property Name="Number" Type="Edm.String" />
        <NavigationProperty Name="Lines" Type="Collection(Shop.OrderLine)" />
        <Annotation Term="Core.Description" String="A customer purchase" />
      </EntityType>
      <EntityType Name="OrderLine" BaseType="Shop.Base">
        <Property Name="Sku" Type="Edm.String" />
      </EntityType>
      <EntityType Name="Part" BaseType="Shop.Base">
        <Property Name="PartNumber" Type="Edm.String" />
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Orders" EntityType="Shop.Order" />
        <EntitySet Name="Lines" EntityType="Shop.OrderLine" />
        <EntitySet Name="Parts" EntityType="Shop.Part" />
      </EntityContainer>
    </Schema>
    <Schema Namespace="Other" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Order">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

async function loadSearch() {
  return createEntitySearch(await parseCSDL(csdl));
}

describe('tokenize', () => {
  it('splits on whitespace and commas and drops empties', () => {
    expect(tokenize('  part,  number ')).toEqual(['part', 'number']);
    expect(tokenize('   ')).toEqual([]);
  });
});

describe('createEntitySearch', () => {
  it('returns everything for an empty query', async () => {
    const search = await loadSearch();
    expect(search('')).toHaveLength(6);
  });

  it('ranks an exact name match first', async () => {
    const search = await loadSearch();
    const results = search('order');
    expect(results[0].entity.qualifiedName).toBe('Shop.Order');
    // Both Shop.Order and Other.Order are matches; entity types beat complex.
    expect(results[1].entity.qualifiedName).toBe('Other.Order');
  });

  it('matches qualified names', async () => {
    const search = await loadSearch();
    const results = search('Other.Order');
    expect(results[0].entity.qualifiedName).toBe('Other.Order');
    expect(results).toHaveLength(1);
  });

  it('matches inherited properties', async () => {
    const search = await loadSearch();
    // Description is declared on Shop.Base, so it must match every subtype.
    const names = search('Description').map((match) => match.entity.qualifiedName);
    expect(names).toContain('Shop.Order');
    expect(names).toContain('Shop.OrderLine');
    expect(names).toContain('Shop.Part');
  });

  it('matches own properties and explains why', async () => {
    const search = await loadSearch();
    const results = search('PartNumber');
    expect(results[0].entity.qualifiedName).toBe('Shop.Part');
    expect(results[0].reasons[0]).toBe('property: partnumber');
  });

  it('matches navigation properties', async () => {
    const search = await loadSearch();
    const results = search('Lines');
    expect(results[0].entity.qualifiedName).toBe('Shop.Order');
    expect(results[0].reasons[0]).toBe('navigation: lines');
  });

  it('matches annotation text', async () => {
    const search = await loadSearch();
    const results = search('customer purchase');
    expect(results.map((match) => match.entity.qualifiedName)).toContain('Shop.Order');
  });

  it('requires every token to match', async () => {
    const search = await loadSearch();
    expect(search('order number').map((m) => m.entity.qualifiedName)).toContain('Shop.Order');
    expect(search('order zzzz')).toHaveLength(0);
  });

  it('is case insensitive and trims input', async () => {
    const search = await loadSearch();
    expect(search('  ORDER  ')[0].entity.qualifiedName).toBe('Shop.Order');
  });

  it('can exclude complex types', async () => {
    const search = await loadSearch();
    const withComplex = search('money').map((m) => m.entity.qualifiedName);
    expect(withComplex).toContain('Shop.Money');
    const withoutComplex = search('money', { includeComplexTypes: false });
    expect(withoutComplex).toHaveLength(0);
  });

  it('respects a result limit', async () => {
    const search = await loadSearch();
    expect(search('order', { limit: 1 })).toHaveLength(1);
  });

  it('reuses the index across queries', async () => {
    const search = await loadSearch();
    const first = search('order');
    const second = search('order');
    // Same entity objects prove the cache is reused rather than rebuilt.
    expect(first[0].entity).toBe(second[0].entity);
  });
});

describe('searchRelationships', () => {
  it('returns all relationships for an empty query', async () => {
    const metadata = await parseCSDL(csdl);
    expect(searchRelationships(metadata.relationships, '')).toHaveLength(
      metadata.relationships.length,
    );
  });

  it('matches by relationship name and endpoints', async () => {
    const metadata = await parseCSDL(csdl);
    expect(searchRelationships(metadata.relationships, 'Order_Lines')).toHaveLength(1);
    expect(searchRelationships(metadata.relationships, 'Sku')).toHaveLength(0);
  });

  it('returns nothing for unmatched terms', async () => {
    const metadata = await parseCSDL(csdl);
    expect(searchRelationships(metadata.relationships, 'zzz')).toHaveLength(0);
  });
});
