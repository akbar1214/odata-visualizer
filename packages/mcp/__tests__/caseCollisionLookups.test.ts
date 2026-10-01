import { describe, it, expect } from 'vitest';
import { createToolHandler } from '../src/tools.js';
import { createMetadataStore } from '../src/store.js';
import { textOf } from './textOf.js';

/**
 * Two schemas differing only in case. Both declare a `DoIt` function and an
 * `Order`/`Line` pair; each `Order` navigation property stays inside its own
 * namespace. CSDL permits this and the parser stores both correctly — the two
 * lookups below answered by lowercasing the argument, so each namespace's
 * question was answered with whichever operation or relationship came first.
 */
const caseCollision = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Shop" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <Function Name="DoIt">
        <ReturnType Type="Edm.String" />
      </Function>
      <EntityType Name="Order">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="Lines" Type="Collection(Shop.Line)" />
      </EntityType>
      <EntityType Name="Line">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <Property Name="ShopLineOnly" Type="Edm.String" />
      </EntityType>
    </Schema>
    <Schema Namespace="SHOP" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <Function Name="DoIt">
        <ReturnType Type="Edm.Int32" />
      </Function>
      <EntityType Name="Order">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="Lines" Type="Collection(SHOP.Line)" />
      </EntityType>
      <EntityType Name="Line">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <Property Name="ShopUpperLineOnly" Type="Edm.String" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

async function caseCollisionHandler() {
  const { parseCSDL } = await import('@odata-visualizer/shared');
  const store = createMetadataStore();
  store.set(await parseCSDL(caseCollision), { sourceName: 'case.xml', sourceType: 'file' });
  return createToolHandler(store);
}

describe('operation lookup under a case-only namespace collision', () => {
  it('answers get_function_details with the spelling that was asked for', async () => {
    const handler = await caseCollisionHandler();

    const upper = await handler('get_function_details', { name: 'SHOP.DoIt' });
    expect(upper.isError).toBeUndefined();
    expect(textOf(upper)).toContain('Unbound function: SHOP.DoIt');
    expect(textOf(upper)).toContain('Return type: Edm.Int32');
    expect(textOf(upper)).not.toContain('Edm.String');

    const lower = await handler('get_function_details', { name: 'Shop.DoIt' });
    expect(lower.isError).toBeUndefined();
    expect(textOf(lower)).toContain('Unbound function: Shop.DoIt');
    expect(textOf(lower)).toContain('Return type: Edm.String');
  });

  it('sketches an invocation against the operation that was asked for', async () => {
    const handler = await caseCollisionHandler();

    const result = await handler('build_function_invocation', { functionName: 'SHOP.DoIt' });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('<serviceRoot>/SHOP.DoIt');
    expect(textOf(result)).not.toContain('<serviceRoot>/Shop.DoIt');
  });
});

describe('relationship lookup under a case-only namespace collision', () => {
  it('answers get_relationships for the namespace that was asked for', async () => {
    const handler = await caseCollisionHandler();

    const upper = textOf(await handler('get_relationships', { entityName: 'SHOP.Order' }));
    expect(upper).toContain('SHOP.Order');
    expect(upper).toContain('SHOP.Line');
    expect(upper).not.toContain('Shop.Order');
    expect(upper).not.toContain('Shop.Line');

    const lower = textOf(await handler('get_relationships', { entityName: 'Shop.Order' }));
    expect(lower).toContain('Shop.Order');
    expect(lower).toContain('Shop.Line');
    expect(lower).not.toContain('SHOP.Order');
    expect(lower).not.toContain('SHOP.Line');
  });

  it('still answers a spelling that matches neither exactly', async () => {
    const handler = await caseCollisionHandler();

    // Case-insensitive matching remains the fallback: an argument that matches
    // no endpoint exactly still reaches both namespaces rather than nothing.
    const result = textOf(await handler('get_relationships', { entityName: 'shop.order' }));

    expect(result).toContain('Shop.Order');
    expect(result).toContain('SHOP.Order');
  });
});
