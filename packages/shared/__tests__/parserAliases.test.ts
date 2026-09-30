import { describe, it, expect } from 'vitest';
import { parseCSDL } from '../src/parser.js';
import { getEffectiveKeys, getEffectiveProperties, resolveInheritanceChain } from '../src/resolve.js';

/**
 * CSDL lets a schema alias its own namespace with `Schema/@Alias`, and every
 * V2/V3 generator that declares `Self.`-prefixed references uses it. The parser
 * only read `edmx:Include/@Alias`, so `Self.Base` and `Self.Widget` were never
 * expanded and the referenced types were invisible.
 */
const selfAliasCsdl = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" Alias="Self" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Base">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <Property Name="Created" Type="Edm.DateTimeOffset" />
      </EntityType>
      <EntityType Name="Widget" BaseType="Self.Base">
        <Property Name="Name" Type="Edm.String" />
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Widgets" EntityType="Self.Widget" />
        <EntitySet Name="Bases" EntityType="Self.Base" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

describe('Schema/@Alias', () => {
  it('expands BaseType so the inheritance chain resolves', async () => {
    const model = await parseCSDL(selfAliasCsdl);
    const widget = model.entities.find((e) => e.name === 'Widget')!;

    expect(widget.baseType).toBe('N.Base');
    expect(resolveInheritanceChain(widget, model.entities).map((e) => e.name)).toEqual([
      'Widget',
      'Base',
    ]);
  });

  it('backfills inherited keys and properties', async () => {
    const model = await parseCSDL(selfAliasCsdl);
    const widget = model.entities.find((e) => e.name === 'Widget')!;

    // Both were empty before: the chain could not be walked, so `getEffectiveKeys`
    // returned nothing and every consumer thought the type had no key.
    expect(getEffectiveKeys(widget, model.entities)).toEqual(['Id']);
    expect(getEffectiveProperties(widget, model.entities).map((p) => p.name)).toEqual([
      'Id',
      'Created',
      'Name',
    ]);
  });

  it('expands an entity set type reference', async () => {
    const model = await parseCSDL(selfAliasCsdl);
    const [widgets] = model.entityContainers[0]!.entitySets;

    expect(widgets.entityTypeQualified).toBe('N.Widget');
    expect(widgets.entityType).toBe('Widget');
  });
});

/**
 * Per CSDL, `edmx:Reference` is a child of `edmx:Edmx` — not of
 * `edmx:DataServices`, which is the only place the parser looked. A reference
 * declared in its standard position was therefore ignored entirely, so its
 * `edmx:Include` aliases were never registered.
 */
describe('root-level edmx:Reference', () => {
  it('registers an Include alias declared on the Edmx root', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:Reference Uri="https://example.org/other.xml">
    <edmx:Include Namespace="Other" Alias="O" />
  </edmx:Reference>
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Base">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <EntityType Name="Derived" BaseType="O.Base">
        <Property Name="Name" Type="Edm.String" />
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Deriveds" EntityType="O.Derived" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);

    // `O` is the alias the reference declares for the `Other` namespace, so the
    // reference expands to `Other.Derived` — unresolvable in this document, but
    // the point is that it is no longer left as the raw `O.Derived`.
    const derived = model.entities.find((e) => e.name === 'Derived')!;
    expect(derived.baseType).toBe('Other.Base');
    expect(model.entityContainers[0]!.entitySets[0].entityTypeQualified).toBe('Other.Derived');
  });

  it('still records an unloadable reference', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:Reference Uri="https://example.org/other.xml">
    <edmx:Include Namespace="Other" Alias="O" />
  </edmx:Reference>
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Thing">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);

    expect(model.unresolvedReferences).toEqual(['https://example.org/other.xml']);
  });
});

/** The existing `edmx:Include` path must keep working unchanged. */
describe('existing alias handling', () => {
  it('still expands an alias from an edmx:Include inside DataServices', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <edmx:Reference Uri="https://example.org/other.xml">
      <edmx:Include Namespace="Other" Alias="O" />
    </edmx:Reference>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Thing">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <EntityType Name="Derived" BaseType="O.Thing" />
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);

    expect(model.entities.find((e) => e.name === 'Derived')!.baseType).toBe('Other.Thing');
  });
});
