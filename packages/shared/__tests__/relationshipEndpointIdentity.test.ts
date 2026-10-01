import { describe, it, expect } from 'vitest';
import { parseCSDL } from '../src/index.js';

/**
 * Two namespaces declare the same type names, and each `Part` navigates to its
 * own `Doc` with the same navigation property name. A relationship identity
 * that is only the short name makes the two indistinguishable: deduplication
 * merges them, so the second one is dropped from the model.
 */
const sameNamesCsdl = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="A" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Part">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="Docs" Type="Collection(A.Doc)" />
      </EntityType>
      <EntityType Name="Doc">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
    </Schema>
    <Schema Namespace="B" xmlns="http://docs.oasis-open.org/odata/ns/edmx">
      <EntityType Name="Part">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="Docs" Type="Collection(B.Doc)" />
      </EntityType>
      <EntityType Name="Doc">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

describe('relationship endpoints are identities', () => {
  it('keeps both relationships when the two namespaces reuse every short name', async () => {
    const model = await parseCSDL(sameNamesCsdl);

    // Two navigation properties (`A.Part.Docs`, `B.Part.Docs`) must produce two
    // relationships. Comparing short names made `Part_Docs -> Part/Doc` look
    // like one relationship and dropped B's.
    expect(model.relationships).toHaveLength(2);
    expect(model.relationships.map((r) => `${r.from.entity}->${r.to.entity}`).sort()).toEqual([
      'A.Part->A.Doc',
      'B.Part->B.Doc',
    ]);
  });

  it('stores the qualified endpoint on a derived V4 relationship', async () => {
    const model = await parseCSDL(sameNamesCsdl);
    const fromA = model.relationships.find((r) => r.namespace === 'A')!;

    expect(fromA.from.entity).toBe('A.Part');
    expect(fromA.to.entity).toBe('A.Doc');
    // The compatibility field still names the same type.
    expect(fromA.from.entityQualified).toBe('A.Part');
    expect(fromA.to.entityQualified).toBe('A.Doc');
  });
});

/**
 * V3 documents write the endpoint on the `<Association>` end. A qualified
 * `Type` must land in `entity` just as it does for a derived relationship, or
 * consumers that read `entity` still have to guess between namespaces.
 */
const v3Csdl = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="3.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="A" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="Part" Relationship="R1" FromRole="Widget" ToRole="Part" />
      </EntityType>
      <EntityType Name="Part">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <Association Name="R1">
        <End Type="A.Widget" Role="Widget" Multiplicity="1" />
        <End Type="B.Part" Role="Part" Multiplicity="*" />
      </Association>
    </Schema>
    <Schema Namespace="B" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Part">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

describe('V3 association ends carry the qualified type', () => {
  it('stores the type reference, not its short name', async () => {
    const model = await parseCSDL(v3Csdl);
    const [rel] = model.relationships;

    expect(rel.from.entity).toBe('A.Widget');
    expect(rel.to.entity).toBe('B.Part');
  });
});

/**
 * The parser expands `Schema/@Alias` after parsing. The relationship endpoint
 * is a second copy of the type reference and must be expanded too — otherwise
 * the identity field keeps the alias nobody can resolve.
 */
describe('alias expansion covers the endpoint identity', () => {
  it('expands an aliased relationship endpoint in both fields', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" Alias="self" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="Kids" Type="Collection(self.Widget)" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);

    const [rel] = model.relationships;
    expect(rel.from.entity).toBe('N.Widget');
    expect(rel.to.entity).toBe('N.Widget');
    expect(rel.from.entityQualified).toBe('N.Widget');
    expect(rel.to.entityQualified).toBe('N.Widget');
  });
});

/**
 * Deduplication compares stored endpoint identities and runs *during* parsing,
 * before the alias-expansion pass. Endpoints that differed only in spelling
 * therefore looked like different relationships.
 */
describe('dedup compares expanded endpoints', () => {
  it('keeps one relationship when the spellings differ only by alias', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" Alias="self" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="Docs" Type="Collection(self.Gadget)" />
      </EntityType>
      <EntityType Name="Gadget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="Parent" Type="N.Widget" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);

    // `self.Gadget` is `N.Gadget`, so this is the mirror of `Docs` and the two
    // are one relationship.
    expect(model.relationships).toHaveLength(1);
  });

  it('keeps two relationships that only looked like reverses under short names', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="A" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="Docs" Type="Collection(B.Part)" />
      </EntityType>
      <EntityType Name="Part">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="Parent" Type="A.Widget" />
      </EntityType>
    </Schema>
    <Schema Namespace="B" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Part">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);

    // `Widget -> Part` and `Part -> Widget` are reverses only if both `Part`s
    // are the same type. They are not: one is `A.Part`, the other `B.Part`.
    expect(model.relationships).toHaveLength(2);
  });
});
