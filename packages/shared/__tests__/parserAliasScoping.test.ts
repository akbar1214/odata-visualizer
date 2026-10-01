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
    // The loaded document declares `O` as well, pointing at itself. A global
    // first-wins table let the referencing document's `O` win, so the loaded
    // document's own types resolved through a stranger's alias. The external
    // assertion below is the discriminating one; the nav relationship alone
    // passes either way.
    const colliding = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="B" Alias="O" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Base">
        <Key><PropertyRef Name="Bid" /></Key>
        <Property Name="Bid" Type="Edm.String" Nullable="false" />
      </EntityType>
      <EntityType Name="Ext" BaseType="O.Base" />
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

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
      { loadExternal: async () => colliding },
    );

    // The loaded document's `O` is its own; it must not resolve to `External`.
    expect(model.entities.find((e) => e.qualifiedName === 'B.Ext')!.baseType).toBe('B.Base');
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

  // Passes against unfixed `main` too, but for the wrong reason: main never
  // expanded `NavigationProperty/@Relationship` at all, so it returned the raw
  // value whatever the guard said. Against this branch it is meaningful —
  // disabling the guard fails it.
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
    expect(
      model.entities.find((e) => e.name === 'Thing')!.navigationProperties[0].relationship,
    ).toBe('X.R9');
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

/**
 * Namespaces are case-sensitive identifiers and `registry` is keyed
 * case-sensitively, but `documentOfNamespace` was keyed lowercased — so
 * `Foo` and `foo` both registered and the second overwrote the first, leaving
 * the first document resolving aliases against the other's table.
 */
describe('namespaces differing only by case stay distinct', () => {
  it('keeps each document resolving against its own table', async () => {
    const external = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="foo" Alias="two" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Base">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <EntityType Name="T2" BaseType="two.Base" />
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

    const model = await parseCSDL(
      `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Foo" Alias="one" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Base">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <EntityType Name="T1" BaseType="one.Base" />
      <edmx:Reference Uri="https://example.org/ext.xml">
        <edmx:Include Namespace="foo" />
      </edmx:Reference>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`,
      { loadExternal: async () => external },
    );

    // Collapsing the key left `Foo.T1` unexpanded, with no inheritance chain.
    expect(model.entities.find((e) => e.qualifiedName === 'Foo.T1')!.baseType).toBe('Foo.Base');
    expect(model.entities.find((e) => e.qualifiedName === 'foo.T2')!.baseType).toBe('foo.Base');
  });
});

/**
 * The three mechanisms the change advertises — per-document aliases for nested
 * references, imports recording their own document, and annotation targets
 * being scoped — were each unpinned: a mutant disabling them survived the suite.
 */
describe('per-document scoping is pinned for each mechanism', () => {
  it('lets a nested reference declare aliases for the document that declares it', async () => {
    // root -> B, and B's own reference declares an alias B itself uses.
    const docC = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="C" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Base">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

    const docB = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:Reference Uri="https://example.org/c.xml">
    <edmx:Include Namespace="C" Alias="co" />
  </edmx:Reference>
  <edmx:DataServices>
    <Schema Namespace="B" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="T" BaseType="co.R1" />
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

    const model = await parseCSDL(
      `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="A" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Root">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <edmx:Reference Uri="https://example.org/b.xml"><edmx:Include Namespace="B" /></edmx:Reference>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`,
      { loadExternal: async (uri) => (uri.includes('c.xml') ? docC : docB) },
    );

    // `co` is declared by document B's own reference, so B's type resolves it.
    expect(model.entities.find((e) => e.qualifiedName === 'B.T')!.baseType).toBe('C.R1');
  });

  it('scopes an annotation target to the document that declares it', async () => {
    const external = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="B" Alias="Self" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Thing">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <Annotations Target="Self.Thing">
        <Annotation Term="Core.Description" String="from B" />
      </Annotations>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

    const model = await parseCSDL(
      `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="A" Alias="Self" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Thing">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <edmx:Reference Uri="https://example.org/b.xml"><edmx:Include Namespace="B" /></edmx:Reference>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`,
      { loadExternal: async () => external },
    );

    // Both documents declare `Self`. B's annotation must land on B's type only.
    expect(
      model.entities.find((e) => e.qualifiedName === 'B.Thing')!.annotations?.['Core.Description'],
    ).toBe('from B');
    expect(model.entities.find((e) => e.qualifiedName === 'A.Thing')!.annotations).toBeUndefined();
  });
});

/** The remaining `a || b` sites are all converted, so both spellings survive. */
describe('mixed spellings survive everywhere', () => {
  it('keeps TypeDefinition, EntityContainer, FunctionImport and ActionImport', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm"
            xmlns:edm="http://docs.oasis-open.org/odata/ns/edm">
      <TypeDefinition Name="T1" UnderlyingType="Edm.String" />
      <edm:TypeDefinition Name="T2" UnderlyingType="Edm.String" />
      <EntityType Name="Thing">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <EntityContainer Name="C1">
        <EntitySet Name="Things" EntityType="N.Thing" />
        <FunctionImport Name="G" Function="N.Fn" />
        <edm:FunctionImport Name="F" Function="N.Fn" />
        <ActionImport Name="GA" Action="N.Act" />
        <edm:ActionImport Name="A" Action="N.Act" />
      </EntityContainer>
      <edm:EntityContainer Name="C2">
        <edm:EntitySet Name="More" EntityType="N.Thing" />
      </edm:EntityContainer>
      <Function Name="Fn"><ReturnType Type="Edm.String" /></Function>
      <Action Name="Act" />
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);

    expect(model.typeDefinitions.map((t) => t.name).sort()).toEqual(['T1', 'T2']);
    expect(model.entityContainers.map((c) => c.name).sort()).toEqual(['C1', 'C2']);
    // Both spellings sit in the *same* container: `a || b` returned only the
    // unprefixed group, so the prefixed import disappeared. Declaring only the
    // prefixed form (as this test did) passes either way and proves nothing.
    expect(model.functionImports.map((f) => f.name)).toEqual(['G', 'F']);
    expect(model.actionImports.map((a) => a.name)).toEqual(['GA', 'A']);
  });

  it('keeps NavigationProperty declared under both spellings', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm"
            xmlns:edm="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="a" Type="Collection(N.Widget)" />
        <edm:NavigationProperty Name="b" Type="Collection(N.Widget)" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);

    // `b` was dropped, and with it the relationship derived from it.
    expect(model.entities[0].navigationProperties.map((n) => n.name)).toEqual(['a', 'b']);
    expect(model.relationships).toHaveLength(2);
  });
});

/**
 * Imports carry no namespace field, so their document is recorded directly.
 * A mutant ignoring that lookup survived the suite — nothing exercised an
 * import whose qualified name is alias-qualified.
 *
 * Two details make this discriminating rather than vacuous:
 *  - the function is declared in the *aliased* namespace, not the container's,
 *    so no already-resolved definition supplies the answer;
 *  - it is declared in a schema parsed *after* the container, so the import
 *    cannot snapshot it at parse time and must expand the alias afterwards;
 *  - the root document declares `bf` too, pointing somewhere else, so falling
 *    back to the wrong document is observable instead of silently agreeing.
 */
describe('imports resolve in their own document', () => {
  it('expands an alias-qualified function import from a loaded document', async () => {
    const external = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="BSvc" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityContainer Name="C">
        <FunctionImport Name="RunIt" Function="bf.DoIt" />
      </EntityContainer>
    </Schema>
    <Schema Namespace="BFuncs" Alias="bf" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <Function Name="DoIt"><ReturnType Type="Edm.String" /></Function>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

    const model = await parseCSDL(
      `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="A" Alias="bf" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Root">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <edmx:Reference Uri="https://example.org/b.xml"><edmx:Include Namespace="BSvc" /></edmx:Reference>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`,
      { loadExternal: async () => external },
    );

    // `bf` in the loaded document is `BFuncs`; ignoring the import's recorded
    // document falls back to the root table, where `bf` is `A`.
    expect(model.functionImports[0].qualifiedFunctionName).toBe('BFuncs.DoIt');
  });
});

/**
 * A relationship derived from a navigation property is named during parsing,
 * so its `@Relationship` is expanded against the *schema's* document. Using the
 * root document's table instead still produced a plausible name — the root's
 * alias — while disagreeing with the navigation property it came from.
 */
describe('derived relationships resolve in their own document', () => {
  it('expands a relationship against the document that declares it', async () => {
    const external = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="E2" Alias="Self" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="Kids" Type="Collection(Self.Widget)" Relationship="Self.R1" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

    const model = await parseCSDL(
      `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="A" Alias="Self" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Root">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <edmx:Reference Uri="https://example.org/e2.xml"><edmx:Include Namespace="E2" /></edmx:Reference>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`,
      { loadExternal: async () => external },
    );

    // Both documents alias `Self`. Against the root table this expands to the
    // root's `A.R1` — a name belonging to a document that never declared it.
    expect(model.relationships.find((r) => r.from.entityQualified === 'E2.Widget')!.name).toBe(
      'E2.R1',
    );
    // And it must agree with the navigation property it was derived from.
    expect(
      model.entities.find((e) => e.qualifiedName === 'E2.Widget')!.navigationProperties[0]
        .relationship,
    ).toBe('E2.R1');
  });
});

/**
 * Merging the two spellings by reading each in turn put every unprefixed
 * element first, reordering a document that declares the prefixed form first.
 * Order is observable: an unqualified annotation target is resolved with
 * `findEntityByName`, which is first-match-wins.
 */
describe('mixed spellings are interleaved, not appended', () => {
  it('keeps entity types in key order rather than unprefixed-first', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm"
            xmlns:edm="http://docs.oasis-open.org/odata/ns/edm">
      <edm:EntityType Name="Zebra">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </edm:EntityType>
      <EntityType Name="Apple">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);

    expect(model.entities.map((e) => e.name)).toEqual(['Zebra', 'Apple']);
  });
});

/**
 * A reference's `Include` aliases are declared by the *referencing* document,
 * so they must apply whether or not the referenced document loads. Root-level
 * references already behaved that way; a nested one registered its aliases only
 * after a successful fetch, so a failed load silently dropped them.
 */
describe('a reference keeps its aliases when its target cannot load', () => {
  it('expands types through an alias whose document never arrived', async () => {
    const midDoc = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:Reference Uri="https://example.org/missing.xml">
    <edmx:Include Namespace="Missing" Alias="miss" />
  </edmx:Reference>
  <edmx:DataServices>
    <Schema Namespace="Mid" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="T" BaseType="miss.Base" />
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

    const model = await parseCSDL(
      `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="A" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Root">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <edmx:Reference Uri="https://example.org/mid.xml"><edmx:Include Namespace="Mid" /></edmx:Reference>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`,
      {
        loadExternal: async (uri: string) => {
          if (uri.includes('mid.xml')) return midDoc;
          throw new Error(`unreachable: ${uri}`);
        },
      },
    );

    expect(model.entities.find((e) => e.qualifiedName === 'Mid.T')!.baseType).toBe('Missing.Base');
  });
});

/**
 * `firstChildText` must read both spellings without going through
 * `childElements`: that helper is element-oriented, and a text-only leaf is
 * handed back as a primitive, which `ensureArray` turns into `[]`. Routing it
 * through the helper dropped every singly-occurring scalar annotation value —
 * labels, descriptions, search terms — while repeated children still arrived as
 * an array and worked, so the loss was invisible.
 */
describe('scalar annotation values survive', () => {
  const withAnnotations = (body: string) => `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm"
            xmlns:edm="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Thing">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <Annotations Target="N.Thing">
${body}
      </Annotations>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

  const annotationsOf = async (body: string) => {
    const model = await parseCSDL(withAnnotations(body));
    return model.entities.find((e) => e.qualifiedName === 'N.Thing')!.annotations;
  };

  it('keeps a single unprefixed scalar', async () => {
    const annotations = await annotationsOf(
      '        <Annotation Term="Core.Description"><String>Customer</String></Annotation>',
    );

    expect(annotations?.['Core.Description']).toBe('Customer');
  });

  it('keeps a single edm-prefixed scalar', async () => {
    const annotations = await annotationsOf(
      '        <Annotation Term="T.Prefixed"><edm:String>Prefixed</edm:String></Annotation>',
    );

    expect(annotations?.['T.Prefixed']).toBe('Prefixed');
  });

  it('keeps a single Bool', async () => {
    const annotations = await annotationsOf(
      '        <Annotation Term="T.Bool"><Bool>true</Bool></Annotation>',
    );

    expect(annotations?.['T.Bool']).toBe('true');
  });

  it('keeps a one-item Collection', async () => {
    const annotations = await annotationsOf(
      '        <Annotation Term="T.One"><Collection><String>one</String></Collection></Annotation>',
    );

    expect(annotations?.['T.One']).toBe('one');
  });

  it('still joins a repeated Collection', async () => {
    const annotations = await annotationsOf(
      '        <Annotation Term="T.Many"><Collection><String>one</String><String>two</String></Collection></Annotation>',
    );

    expect(annotations?.['T.Many']).toBe('one, two');
  });
});

/**
 * The conversions at the `Annotations` and `NavigationPropertyBinding` sites
 * were unpinned: dropping the prefix argument reverted them to first-spelling
 * only and the suite stayed green, because no test declared the prefixed form
 * *alone*. Worth pinning — both were supported before the conversion.
 */
describe('prefixed-only spellings survive', () => {
  it('keeps a prefixed-only Annotations block and navigation binding', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm"
            xmlns:edm="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Thing">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <EntityContainer Name="C">
        <EntitySet Name="Things" EntityType="N.Thing">
          <edm:NavigationPropertyBinding Path="Others" Target="N.Others" />
        </EntitySet>
      </EntityContainer>
      <edm:Annotations Target="N.Thing">
        <Annotation Term="Core.Description" String="from the prefixed block" />
      </edm:Annotations>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);

    expect(
      model.entities.find((e) => e.qualifiedName === 'N.Thing')!.annotations?.['Core.Description'],
    ).toBe('from the prefixed block');
    const things = model.entityContainers[0].entitySets.find((s) => s.name === 'Things')!;
    expect(things.navigationPropertyBindings?.map((b) => b.path)).toEqual(['Others']);
  });
});

/**
 * Deleting this loop outright left the whole suite green: no test ever put a
 * `NavigationProperty` on a `ComplexType`, so the conversion there was
 * unverified and the path had no coverage at all.
 */
describe('ComplexType navigation properties', () => {
  it('keeps both spellings on a complex type', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm"
            xmlns:edm="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Thing">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <ComplexType Name="Addr">
        <NavigationProperty Name="a" Type="Collection(N.Thing)" />
        <edm:NavigationProperty Name="b" Type="Collection(N.Thing)" />
      </ComplexType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);

    const complex = model.entities.find((e) => e.qualifiedName === 'N.Addr')!;
    expect(complex.navigationProperties.map((n) => n.name)).toEqual(['a', 'b']);
  });
});

/**
 * The `Collection` conversion is only observable when both spellings coexist:
 * `ann['Collection'] ?? ann['edm:Collection']` always preferred the unprefixed
 * one, whatever order the document used. Two `Collection` children in one
 * annotation is invalid CSDL, so this exists purely to pin the conversion.
 */
describe('the Collection conversion is pinned', () => {
  it('reads whichever spelling the document declares first', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm"
            xmlns:edm="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Thing">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <Annotations Target="N.Thing">
        <Annotation Term="T.Both"><edm:Collection><String>prefixed</String></edm:Collection><Collection><String>plain</String></Collection></Annotation>
      </Annotations>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);

    expect(model.entities.find((e) => e.qualifiedName === 'N.Thing')!.annotations?.['T.Both']).toBe(
      'prefixed',
    );
  });
});
