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
 * `BoundLines` returns an entity type, so the traversal graph emits an
 * operation edge for the relationship lookup's second half to filter.
 */
const caseCollision = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Shop" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <Function Name="DoIt">
        <ReturnType Type="Edm.String" />
      </Function>
      <Function Name="BoundLines" IsBound="true">
        <Parameter Name="it" Type="Shop.Order" />
        <ReturnType Type="Collection(Shop.Line)" />
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
      <Function Name="BoundLines" IsBound="true">
        <Parameter Name="it" Type="SHOP.Order" />
        <ReturnType Type="Collection(SHOP.Line)" />
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

  it('resolves a case-mismatched qualified name through the fallback', async () => {
    // #73.5: `shop.doit` matches neither spelling exactly, so both namespaces'
    // candidates survive the lowercased fallback; the declaration order picks
    // `Shop.DoIt`. The fallback resolving at all is what is pinned.
    const handler = await caseCollisionHandler();

    const result = await handler('get_function_details', { name: 'shop.doit' });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('Unbound function: Shop.DoIt');
    expect(textOf(result)).toContain('Return type: Edm.String');
  });

  it('resolves a bare function name through the fallback', async () => {
    // `DoIt` is declared in both namespaces, so a bare name cannot be
    // disambiguated: the first declaration answers rather than an error. The
    // qualified spelling above is the precise form.
    const handler = await caseCollisionHandler();

    const result = await handler('get_function_details', { name: 'DoIt' });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('Unbound function: Shop.DoIt');
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
    // The bound-function operation edges follow the same fallback: both
    // namespaces' edges surface for a spelling that matches neither exactly.
    expect(result).toContain('Shop.BoundLines()');
    expect(result).toContain('SHOP.BoundLines()');
  });

  it('filters the bound-function operation edges by exact namespace too', async () => {
    // #73.4: the operation-edge half of the #41 filter. Only an
    // entity-returning bound function produces a traversal edge, which is why
    // the unbound `DoIt` functions left this branch unpinned — reverting it to
    // the old lowercased filter returned both namespaces' edges for either
    // spelling while every test stayed green.
    const handler = await caseCollisionHandler();

    const upper = textOf(await handler('get_relationships', { entityName: 'SHOP.Order' }));
    expect(upper).toContain('SHOP.BoundLines(): SHOP.Order -> Collection(SHOP.Line)');
    expect(upper).not.toContain('Shop.BoundLines()');

    const lower = textOf(await handler('get_relationships', { entityName: 'Shop.Order' }));
    expect(lower).toContain('Shop.BoundLines(): Shop.Order -> Collection(Shop.Line)');
    expect(lower).not.toContain('SHOP.BoundLines()');
  });
});

/**
 * #73 item 6: an explicit `<Association>` whose `End Type` is short stores
 * unqualified endpoints, so both namespaces' ends are the string `Order` and
 * the lookup cannot tell them apart. This is the V3 shape — V4
 * navigation-derived relationships store qualified endpoints and are
 * discriminated exactly (above). Pre-existing and recorded here.
 */
const v3ShortEnds = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Shop" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Order">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <EntityType Name="Line">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <Association Name="R1">
        <End Type="Order" Role="Order" Multiplicity="1" />
        <End Type="Line" Role="Line" Multiplicity="*" />
      </Association>
    </Schema>
    <Schema Namespace="SHOP" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Order">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <EntityType Name="Line">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <Association Name="R1">
        <End Type="Order" Role="Order" Multiplicity="1" />
        <End Type="Line" Role="Line" Multiplicity="*" />
      </Association>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

async function v3ShortEndHandler() {
  const { parseCSDL } = await import('@odata-visualizer/shared');
  const store = createMetadataStore();
  store.set(await parseCSDL(v3ShortEnds), { sourceName: 'v3.xml', sourceType: 'file' });
  return createToolHandler(store);
}

describe('V3-short-endpoint associations under a case collision (recorded limitation)', () => {
  it('returns both namespaces’ relationships for either spelling', async () => {
    const handler = await v3ShortEndHandler();

    const upper = textOf(await handler('get_relationships', { entityName: 'SHOP.Order' }));
    const lower = textOf(await handler('get_relationships', { entityName: 'Shop.Order' }));

    // Both lines render identically: the short endpoint cannot carry a
    // namespace, so the two `R1`s are indistinguishable rather than filtered.
    expect(upper.match(/R1: Order \(1\) <-> Line \(\*\)/g)).toHaveLength(2);
    expect(lower.match(/R1: Order \(1\) <-> Line \(\*\)/g)).toHaveLength(2);
  });
});
