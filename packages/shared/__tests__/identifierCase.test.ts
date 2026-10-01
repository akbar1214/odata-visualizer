import { describe, it, expect } from 'vitest';
import { parseCSDL } from '../src/parser.js';
import { findEntityByName, findEntitySet } from '../src/resolve.js';

/**
 * CSDL identifiers are case-sensitive, but this codebase matches them
 * case-insensitively — deliberately, because services in the wild are sloppy
 * about case and a strict match would reject models that work against their own
 * server. The hazard recorded on #18 is not the case-insensitivity itself: it is
 * that the case-insensitive fallback made the answer depend on document order,
 * so a model declaring both `Shop.Order` and `SHOP.Order` could silently bind
 * either. An exact-case match now wins, and the fallback is only a fallback.
 */
const twoNamespaces = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Shop" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Order">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <EntityContainer Name="C">
        <EntitySet Name="Orders" EntityType="Shop.Order" />
        <EntitySet Name="ORDERS" EntityType="SHOP.Order" />
      </EntityContainer>
    </Schema>
    <Schema Namespace="SHOP" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Order">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

describe('a case-only collision resolves to the spelling that was asked for', () => {
  it('prefers the exact-case qualified type over the first case-insensitive match', async () => {
    const model = await parseCSDL(twoNamespaces);

    // Both schemas declare `Order`, and `Shop` comes first in the document.
    expect(findEntityByName(model.entities, 'SHOP.Order')?.qualifiedName).toBe('SHOP.Order');
    expect(findEntityByName(model.entities, 'Shop.Order')?.qualifiedName).toBe('Shop.Order');
  });

  it('prefers the exact-case entity set', async () => {
    const model = await parseCSDL(twoNamespaces);

    // `Orders` is declared first, so a case-insensitive scan returns it for
    // either spelling.
    expect(findEntitySet(model, 'ORDERS')?.name).toBe('ORDERS');
    expect(findEntitySet(model, 'Orders')?.name).toBe('Orders');
  });

  it('still resolves a differently-cased name that matches nothing exactly', async () => {
    const model = await parseCSDL(twoNamespaces);

    // Nothing is spelled this way, so the fallback applies — and must keep
    // working, because it is what lets sloppy models resolve at all.
    expect(findEntityByName(model.entities, 'shop.order')?.qualifiedName).toBe('Shop.Order');
    expect(findEntitySet(model, 'orders')?.name).toBe('Orders');
  });

  it('still resolves a short name that is unambiguous', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Only" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);

    expect(findEntityByName(model.entities, 'widget')?.qualifiedName).toBe('Only.Widget');
  });
});
