import { describe, it, expect } from 'vitest';
import { parseCSDL } from '../src/parser.js';
import { getEffectiveKeys, getEffectiveProperties } from '../src/resolve.js';

/**
 * CSDL 4.01 §4.2: *"An alias is only valid within the document in which it is
 * declared."* A single document-global map made two documents that each declare
 * the same alias collide first-wins, so a derived type in the second document
 * silently inherited from the **first** document's base — wrong properties,
 * wrong keys, wrong inheritance chain.
 */
describe('aliases are scoped to their own document', () => {
  const external = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="B" Alias="Self" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Base">
        <Key><PropertyRef Name="Bid" /></Key>
        <Property Name="Bid" Type="Edm.String" Nullable="false" />
      </EntityType>
      <EntityType Name="Ext" BaseType="Self.Base" />
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

  const root = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="A" Alias="Self" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Base">
        <Key><PropertyRef Name="Aid" /></Key>
        <Property Name="Aid" Type="Edm.String" Nullable="false" />
      </EntityType>
      <EntityType Name="Thing" BaseType="Self.Base" />
      <edmx:Reference Uri="https://example.org/ext.xml">
        <edmx:Include Namespace="B" />
      </edmx:Reference>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

  it('resolves each document against its own alias table', async () => {
    const model = await parseCSDL(root, { loadExternal: async () => external });

    // Both documents declare `Self` for a *different* namespace.
    const thing = model.entities.find((e) => e.qualifiedName === 'A.Thing')!;
    const ext = model.entities.find((e) => e.qualifiedName === 'B.Ext')!;

    expect(thing.baseType).toBe('A.Base');
    expect(ext.baseType).toBe('B.Base');
  });

  it('gives each derived type the keys of its own base', async () => {
    const model = await parseCSDL(root, { loadExternal: async () => external });
    const ext = model.entities.find((e) => e.qualifiedName === 'B.Ext')!;

    // Before, this inherited the root document's `Aid` from the wrong base.
    expect(getEffectiveKeys(ext, model.entities)).toEqual(['Bid']);
    expect(getEffectiveProperties(ext, model.entities).map((p) => p.name)).toEqual(['Bid']);
  });

  it('keeps an Include alias scoped to the document that declared it', async () => {
    const model = await parseCSDL(
      `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Root" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Thing">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="Kids" Relationship="O.R9" />
      </EntityType>
      <edmx:Reference Uri="https://example.org/ext.xml">
        <edmx:Include Namespace="External" Alias="O" />
      </edmx:Reference>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`,
      { loadExternal: async () => external },
    );

    // The reference's `Include` alias belongs to the referencing document.
    expect(model.entities[0].navigationProperties[0].relationship).toBe('External.R9');
  });
});

/**
 * `a || b` returns only the first spelling, so an element carrying both the
 * unprefixed and the `edm:`-prefixed form silently lost a group. The pattern
 * appeared at ~20 sites, not just the two originally flagged.
 */
describe('mixed-prefix siblings are all collected', () => {
  it('keeps EntityType and Property declared under both spellings', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm"
            xmlns:edm="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Alpha">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <edm:EntityType Name="Beta">
        <edm:Key><edm:PropertyRef Name="Id" /></edm:Key>
        <edm:Property Name="Id" Type="Edm.String" Nullable="false" />
      </edm:EntityType>
      <EntityType Name="Gamma">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <edm:Property Name="Extra" Type="Edm.String" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);

    // `Beta` and `Extra` used to be dropped without a word.
    expect(model.entities.map((e) => e.name).sort()).toEqual(['Alpha', 'Beta', 'Gamma']);
    const gamma = model.entities.find((e) => e.name === 'Gamma')!;
    expect(gamma.properties.map((p) => p.name)).toContain('Extra');
  });

  it('registers aliases from both Include spellings', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Reference Uri="https://example.org/ext.xml">
      <Include Namespace="Ext1" Alias="e1" />
      <edmx:Include Namespace="Ext2" Alias="e2" />
    </Reference>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Thing">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="Kids" Relationship="e2.R9" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);

    expect(model.entities[0].navigationProperties[0].relationship).toBe('Ext2.R9');
  });
});

/**
 * The ordering rules #25 introduced were unspecified and unverified — three
 * mutants survived its suite. These pin the two that are observable.
 */
describe('alias registration precedence', () => {
  it('lets a document own alias win over an alias from a reference it includes', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Reference Uri="https://example.org/ext.xml">
      <Include Namespace="FromInclude" Alias="X" />
    </Reference>
    <Schema Namespace="Mine" Alias="X" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Thing">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="Kids" Relationship="X.R9" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);

    // First-wins within a document: the schema's own alias is registered
    // before the references are read.
    expect(model.entities[0].navigationProperties[0].relationship).toBe('Mine.R9');
  });

  it('gives a schema its own namespace back, never another document aliasing it', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Y" Alias="X" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
    </Schema>
    <Schema Namespace="X" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Thing">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="Kids" Relationship="X.R9" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);

    // `X` is a real schema, so it beats the `Alias="X"` declared on `Y`.
    expect(model.entities.find((e) => e.name === 'Thing')!.navigationProperties[0].relationship).toBe(
      'X.R9',
    );
  });
});

/**
 * The relationship is *derived* from the navigation property, so expanding only
 * `nav.relationship` afterwards left the derived copy stale — a document
 * disagreeing with the relationship derived from it.
 */
describe('the derived relationship carries the expanded association name', () => {
  it('agrees with the navigation property it came from', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" Alias="Self" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="Kids" Type="Collection(N.Widget)" Relationship="Self.R1" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);

    const nav = model.entities[0].navigationProperties[0];
    expect(nav.relationship).toBe('N.R1');
    // The derived copy used to say `Self.R1`.
    expect(model.relationships.map((r) => r.name)).toContain('N.R1');
    expect(model.relationships.some((r) => r.name === 'Self.R1')).toBe(false);
  });
});
