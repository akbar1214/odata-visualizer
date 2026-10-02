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
  getEntitySelectionValue,
  resolveResourcePath,
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
    expect(url).toContain('$filter=Total%20gt%20100');
    expect(url).toContain("contains(Number,'A%26B')");
    expect(url).toContain('$select=Id,Number');
    expect(url).toContain('$orderby=Number%20desc');
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
      "/Orders?$expand=Lines($select=Sku;$filter=Sku%20eq%20'X1')&$top=25",
    );
  });

  it('degrades gracefully for an unknown entity', async () => {
    const model = await loadModel();
    expect(buildODataQuery(getDefaultQuery('Nope'), model)).toBe('');
  });
});

/**
 * An OData resource path is addressed by **entity set** name, not by entity type
 * name. The builder used `query.entityName` (a type) as the path segment, so
 * against the repo's own demo model it emitted `/Product` where the service
 * exposes `/Products` — a 404 for every service whose set name differs from its
 * type name, which is most of them.
 */
describe('buildODataQuery resource path', () => {
  it('addresses the entity set the type belongs to, not the type name', async () => {
    const model = await loadModel();
    expect(buildODataQuery(getDefaultQuery('Order'), model)).toBe('/Orders?$top=25');
    expect(buildODataQuery(getDefaultQuery('OrderLine'), model)).toBe('/Lines?$top=25');
  });

  it('still types a filter against the selected type, not the set name', async () => {
    const model = await loadModel();
    // `Number` is an Edm.String on Shop.Order, so "100" must stay quoted. This
    // discriminates: typo the property name and the fallback would emit a bare
    // numeric literal instead.
    const query = {
      ...getDefaultQuery('Order'),
      filters: [{ property: 'Number', operator: 'eq', value: '100' }],
    };

    expect(buildODataQuery(query, model)).toBe("/Orders?$filter=Number%20eq%20'100'&$top=25");
  });

  it('resolves the set through a qualified entity name', async () => {
    const model = await loadModel();
    expect(buildODataQuery(getDefaultQuery('Shop.Order'), model)).toBe('/Orders?$top=25');
  });

  it('keeps the same set when a type has several, in document order', async () => {
    const model = await loadModel();
    model.entityContainers[0]!.entitySets.push({
      name: 'ArchivedOrders',
      entityType: 'Order',
      entityTypeQualified: 'Shop.Order',
    });

    // Neither set is more canonical than the other; the first declaration wins.
    expect(buildODataQuery(getDefaultQuery('Order'), model)).toBe('/Orders?$top=25');
  });
});

/**
 * Namespace collisions are the norm in real models — the repo's own Windchill
 * fixture has two `Part` types — so matching a set by its *short* type name is
 * not enough: a qualified selection must reach the set in its own namespace.
 */ describe('buildODataQuery with colliding short names', () => {
  const collisionCsdl = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="A" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Product">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <Property Name="AName" Type="Edm.String" />
      </EntityType>
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
    </Schema>
    <Schema Namespace="B" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Product">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <Property Name="BName" Type="Edm.String" />
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="BProducts" EntityType="B.Product" />
        <EntitySet Name="AProducts" EntityType="A.Product" />
        <EntitySet Name="Product" EntityType="A.Widget" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

  it('resolves a qualified name to the set in its own namespace', async () => {
    const model = await parseCSDL(collisionCsdl);
    // BProducts is declared first; A.Product must still reach AProducts.
    expect(resolveResourcePath('A.Product', model)).toBe('AProducts');
    expect(resolveResourcePath('B.Product', model)).toBe('BProducts');
  });

  it('does not let a set named like another type capture it', async () => {
    const model = await parseCSDL(collisionCsdl);

    // There is a set literally named `Product`, but it belongs to A.Widget.
    // `Product` is also a type name, and the builder always passes a *type*, so
    // the type wins: this must reach A.Product's set, not A.Widget's.
    expect(resolveResourcePath('Product', model)).toBe('AProducts');
    expect(buildODataQuery(getDefaultQuery('Product'), model)).toBe('/AProducts?$top=25');
  });

  it('does not accept a bare entity set name', async () => {
    const model = await parseCSDL(collisionCsdl);
    // `BProducts` is a genuine set, but the builder resolves a *type* first and
    // returns before this helper runs, so a set name cannot reach it. The old
    // expectation here exercised the exported helper only and implied a builder
    // capability that does not exist (#18 item 4).
    expect(resolveResourcePath('BProducts', model)).toBeUndefined();
  });

  it('types filters against the selected namespace, not the first set', async () => {
    const model = await parseCSDL(collisionCsdl);
    // BName exists only on B.Product; a wrong-set match would drop the filter.
    expect(
      buildODataQuery(
        {
          ...getDefaultQuery('B.Product'),
          filters: [{ property: 'BName', operator: 'eq', value: 'x' }],
        },
        model,
      ),
    ).toBe("/BProducts?$filter=BName%20eq%20'x'&$top=25");
  });
});

/**
 * CSDL 4.01 requires a namespace- or alias-qualified type reference on an entity
 * set, but real documents ship short ones. A short reference that is ambiguous
 * across schemas must not silently pick one in document order.
 */
describe('buildODataQuery with an unqualified entity set type reference', () => {
  const shortRefCsdl = (containerNamespace: string) => `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="A" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Product">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
    </Schema>
    <Schema Namespace="B" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Product">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="${containerNamespace}Products" EntityType="Product" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

  it('does not bind an ambiguous short reference to either namespace', async () => {
    const model = await parseCSDL(shortRefCsdl('B'));

    // `Product` names two types, so the reference is genuinely ambiguous and
    // must resolve to nothing rather than to whichever schema came first.
    expect(resolveResourcePath('A.Product', model)).toBeUndefined();
    expect(resolveResourcePath('B.Product', model)).toBeUndefined();
  });

  it('resolves a short reference when only one type has that name', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="A" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Product">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Products" EntityType="Product" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);

    expect(resolveResourcePath('Product', model)).toBe('Products');
  });

  it('recovers a set whose type reference uses an unexpanded alias', async () => {
    // The parser now expands `Schema/@Alias` and a root-level `edmx:Reference`,
    // so this fallback is mostly redundant. It still covers a document whose
    // set type reference is a bare short name, which the parser cannot expand.
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" Alias="self" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Widgets" EntityType="self.Widget" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);

    expect(resolveResourcePath('Widget', model)).toBe('Widgets');
    expect(buildODataQuery(getDefaultQuery('Widget'), model)).toBe('/Widgets?$top=25');
  });

  it('does not recover an alias reference when the short name is ambiguous', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="A" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
    </Schema>
    <Schema Namespace="B" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Widgets" EntityType="other.Widget" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);

    // `Widget` names two types, so the alias fallback must refuse for both.
    expect(resolveResourcePath('A.Widget', model)).toBeUndefined();
    expect(resolveResourcePath('B.Widget', model)).toBeUndefined();
  });
});

/**
 * A derived type has no entity set of its own; OData V4 addresses it through the
 * base type's set with a cast. The repo's demo model has three such types, and
 * without this they still produced 404s.
 */
describe('buildODataQuery for derived types', () => {
  it('addresses a derived type through its base set with a cast', async () => {
    const model = await loadModel();
    model.entities.push({
      name: 'BulkOrder',
      qualifiedName: 'Shop.BulkOrder',
      namespace: 'Shop',
      kind: 'entity',
      baseType: 'Shop.Order',
      properties: [],
      navigationProperties: [],
      keys: [],
    });

    expect(resolveResourcePath('BulkOrder', model)).toBe('Orders/Shop.BulkOrder');
    expect(buildODataQuery(getDefaultQuery('BulkOrder'), model)).toBe(
      '/Orders/Shop.BulkOrder?$top=25',
    );
  });

  it('types a derived-only property against the derived type', async () => {
    const model = await loadModel();
    model.entities.push({
      name: 'BulkOrder',
      qualifiedName: 'Shop.BulkOrder',
      namespace: 'Shop',
      kind: 'entity',
      baseType: 'Shop.Order',
      properties: [
        // Edm.String, and a numeric-looking value: if this were typed against
        // the set's type (`Shop.Order`, which has no `SerialKey`) the fallback
        // would infer Edm.Double and emit a bare `100`.
        { name: 'SerialKey', type: 'Edm.String', nullable: true, isKey: false },
      ],
      navigationProperties: [],
      keys: [],
    });

    const url = buildODataQuery(
      {
        ...getDefaultQuery('BulkOrder'),
        filters: [{ property: 'SerialKey', operator: 'eq', value: '100' }],
      },
      model,
    );

    expect(url).toBe("/Orders/Shop.BulkOrder?$filter=SerialKey%20eq%20'100'&$top=25");
  });
});

/**
 * Emitting a path that cannot be resolved is worse than emitting none: the
 * preview looked like a working query. Complex types cannot be set types at all,
 * and a type with no set anywhere in its inheritance chain has no resource path.
 */
describe('buildODataQuery for unaddressable types', () => {
  it('emits nothing for a complex type', async () => {
    const model = await loadModel();
    expect(resolveResourcePath('Money', model)).toBeUndefined();
    expect(buildODataQuery(getDefaultQuery('Money'), model)).toBe('');
  });

  it('emits nothing for a type with no set in its inheritance chain', async () => {
    const model = await loadModel();
    expect(resolveResourcePath('Base', model)).toBeUndefined();
    expect(buildODataQuery(getDefaultQuery('Base'), model)).toBe('');
  });

  it('emits nothing when the document has no container at all', async () => {
    const model = await loadModel();
    model.entityContainers = [];
    expect(buildODataQuery(getDefaultQuery('Order'), model)).toBe('');
  });

  it('does not treat a bare entity set name as addressable', async () => {
    const model = await loadModel();
    // This test was called "still builds a path when an entity set is named
    // directly", but it only ever called this helper: `buildODataQuery` resolves
    // the type first and returns before reaching it, so no builder path can pass
    // a set name (#18 item 4).
    expect(resolveResourcePath('Orders', model)).toBeUndefined();
  });

  it('uses the resolved set in the fallback path, not the type name', async () => {
    const model = await loadModel();
    // `foo) or (1 eq 1` is not a valid property path, so `buildQueryUrl` throws
    // and the `catch` produces the bare resource path. That fallback used to
    // return `/${query.entityName}` — the very bug this PR fixes.
    const url = buildODataQuery(
      {
        ...getDefaultQuery('Order'),
        filters: [{ property: 'foo) or (1 eq 1', operator: 'eq', value: 'x' }],
      },
      model,
    );

    expect(url).toBe('/Orders');
    expect(url).not.toContain('Order?');
  });
});

/**
 * The resource path is concatenated with the query options, so it must be
 * asserted before it is used. `buildODataQuery` used `buildQueryOptions`
 * directly, which skipped the assertion `buildQueryUrl` performs: a set name
 * such as `As?evil=1` was emitted with the options folded into the query string
 * and no warning at all.
 */
describe('buildODataQuery asserts the resolved resource segment', () => {
  const evilSetCsdl = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="A">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <EntityContainer Name="C1">
        <EntitySet Name="As?evil=1" EntityType="N.A" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

  it('warns and drops the options when the set is not a resource path', async () => {
    const model = await parseCSDL(evilSetCsdl);
    const warnings: string[] = [];
    const url = buildODataQuery(getDefaultQuery('A'), model, (message) => warnings.push(message));

    // Encoded on emit: raw, `?` and `=` would fold the refused name into the
    // query string of a request that still looks like a working set path.
    expect(url).toBe('/As%3Fevil%3D1');
    expect(url).not.toContain('$top');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Invalid entitySet');
  });

  const fragmentSetCsdl = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Thing">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <EntityContainer Name="C1">
        <EntitySet Name="Th#ings" EntityType="N.Thing" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

  it('encodes the fallback so a # in the set name cannot truncate the path', async () => {
    const model = await parseCSDL(fragmentSetCsdl);
    const warnings: string[] = [];
    const url = buildODataQuery(getDefaultQuery('Thing'), model, (message) => warnings.push(message));

    // `assertResourceSegment` is right to refuse the name; the fallback must
    // not undo the refusal by re-emitting it raw, or a pasted `/Th#ings`
    // truncates at the fragment and lands on `/Th`.
    expect(url).toBe('/Th%23ings');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/could not be built/);
    expect(warnings[0]).toContain('Invalid entitySet');
  });
});

/**
 * Two types can share a short name — the Windchill fixture ships two `Part`
 * types. The selector must not hand the builder the same string for both, or the
 * selection silently resolves to whichever type the parser saw first and queries
 * the wrong collection.
 */
describe('entity selection identity', () => {
  const twoParts = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="PTC" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Part">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Parts" EntityType="PTC.Part" />
      </EntityContainer>
    </Schema>
    <Schema Namespace="common" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Part">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <Property Name="title" Type="Edm.String" />
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="CommonParts" EntityType="common.Part" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

  it('falls back to the qualified name only for colliding short names', async () => {
    const model = await parseCSDL(twoParts);
    const [ptcPart] = model.entities.filter((e) => e.name === 'Part');
    const commonPart = model.entities.find((e) => e.qualifiedName === 'common.Part')!;

    expect(getEntitySelectionValue(ptcPart, model.entities)).toBe('PTC.Part');
    expect(getEntitySelectionValue(commonPart, model.entities)).toBe('common.Part');
  });

  it('keeps using the short name when it is unique', async () => {
    const model = await loadModel();
    const order = model.entities.find((e) => e.name === 'Order')!;
    expect(getEntitySelectionValue(order, model.entities)).toBe('Order');
  });

  it('queries the selected namespace, not the first one', async () => {
    const model = await parseCSDL(twoParts);
    const commonPart = model.entities.find((e) => e.qualifiedName === 'common.Part')!;
    const value = getEntitySelectionValue(commonPart, model.entities);

    // Without the disambiguation both entries emit "Part" and this resolves to
    // PTC's `Parts`, returning the wrong collection with a 200.
    expect(buildODataQuery(getDefaultQuery(value), model)).toBe('/CommonParts?$top=25');

    const ptcPart = model.entities.find((e) => e.qualifiedName === 'PTC.Part')!;
    expect(
      buildODataQuery(getDefaultQuery(getEntitySelectionValue(ptcPart, model.entities)), model),
    ).toBe('/Parts?$top=25');
  });
});

/**
 * The selector emits a *qualified* name when two types share a short name, so
 * the builder has to accept one. Under a case-only collision the conservative
 * ambiguity guard rejected both spellings, leaving a type that plainly is
 * exposed reporting "not exposed as an entity set".
 */
describe('a case-colliding type is addressable through its exact reference', () => {
  const caseCollision = `<?xml version="1.0" encoding="utf-8"?>
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

  it('binds the set that names the type exactly', async () => {
    const model = await parseCSDL(caseCollision);

    expect(resolveResourcePath('SHOP.Order', model)).toBe('ORDERS');
    expect(resolveResourcePath('Shop.Order', model)).toBe('Orders');
  });

  it('builds a query for it rather than calling it unexposed', async () => {
    const model = await parseCSDL(caseCollision);

    expect(buildODataQuery(getDefaultQuery('SHOP.Order'), model)).toContain('/ORDERS');
  });
});
