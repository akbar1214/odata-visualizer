import { describe, it, expect } from 'vitest';
import { parseCSDL } from '../src/parser.js';

/**
 * CSDL puts most annotations in schema-level `<Annotations Target="...">`
 * blocks rather than inline on the element — it is the canonical way to
 * annotate a type defined elsewhere, and the only way to annotate a property of
 * one. `parseAnnotations` reads only direct `<Annotation>` children, so every
 * one of these was dropped.
 */
const targetedCsdl = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <Property Name="Name" Type="Edm.String" />
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Widgets" EntityType="N.Widget" />
      </EntityContainer>
      <Annotations Target="N.Widget">
        <Annotation Term="Core.Description" String="A widget" />
        <Annotation Term="Org.OData.Capabilities.V1.InsertRestrictions">
          <Record><PropertyValue Property="Insertable" Bool="false" /></Record>
        </Annotation>
      </Annotations>
      <Annotations Target="N.Widget/Name">
        <Annotation Term="Core.Description" String="The widget name" />
      </Annotations>
      <Annotations Target="Container/Widgets">
        <Annotation Term="Core.Description" String="All widgets" />
      </Annotations>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

describe('schema-level Annotations Target', () => {
  it('applies a type-targeted annotation to the entity', async () => {
    const model = await parseCSDL(targetedCsdl);
    const widget = model.entities.find((e) => e.name === 'Widget')!;

    expect(widget.annotations?.['Core.Description']).toBe('A widget');
  });

  it('derives the Core.Description label from a targeted annotation', async () => {
    const model = await parseCSDL(targetedCsdl);
    const widget = model.entities.find((e) => e.name === 'Widget')!;

    // `labelFromAnnotations` reads the same map, so the diagram and explorer
    // should show the description without any extra work.
    expect(widget.label).toBe('A widget');
  });

  it('applies a property-targeted annotation to the property', async () => {
    const model = await parseCSDL(targetedCsdl);
    const widget = model.entities.find((e) => e.name === 'Widget')!;
    const name = widget.properties.find((p) => p.name === 'Name')!;

    expect(name.annotations?.['Core.Description']).toBe('The widget name');
  });

  it('applies an entity-set-targeted annotation to the set', async () => {
    const model = await parseCSDL(targetedCsdl);
    const set = model.entityContainers[0]!.entitySets[0];

    expect(set.annotations?.['Core.Description']).toBe('All widgets');
  });

  it('records a structured annotation rather than dropping it', async () => {
    const model = await parseCSDL(targetedCsdl);
    const widget = model.entities.find((e) => e.name === 'Widget')!;

    expect(widget.annotations?.['Org.OData.Capabilities.V1.InsertRestrictions']).toBeDefined();
  });

  it('lets an inline annotation win over a targeted one', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <Annotation Term="Core.Description" String="Inline" />
      </EntityType>
      <Annotations Target="N.Widget">
        <Annotation Term="Core.Description" String="Targeted" />
      </Annotations>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);
    const widget = model.entities.find((e) => e.name === 'Widget')!;

    // The declaration on the element itself is the more specific one.
    expect(widget.annotations?.['Core.Description']).toBe('Inline');
  });

  it('ignores a target that names nothing in the document', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <Annotations Target="N.Missing">
        <Annotation Term="Core.Description" String="Nowhere" />
      </Annotations>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);

    expect(model.entities.map((e) => e.name)).toEqual(['Widget']);
    expect(model.entities[0].annotations).toBeUndefined();
  });
});

/**
 * The spec form of a set target is the *qualified* container name
 * (`ODataDemo.DemoService/Suppliers`), which is what the repo's own
 * `odata-demo-metadata.xml` uses. Only an unqualified `Container/Set` was
 * matched, so the fixture that motivated this change stayed half-broken.
 */
describe('qualified container targets', () => {
  const csdl = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Widgets" EntityType="N.Widget" />
      </EntityContainer>
      <Annotations Target="N.Container/Widgets">
        <Annotation Term="Core.Description" String="Qualified container" />
      </Annotations>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

  it('matches a namespace-qualified container name', async () => {
    const model = await parseCSDL(csdl);
    const set = model.entityContainers[0]!.entitySets[0];

    expect(set.annotations?.['Core.Description']).toBe('Qualified container');
    expect(set.label).toBe('Qualified container');
  });
});

/**
 * A schema child is always namespace-qualified, so an unqualified first segment
 * cannot be a type. Without that rule `C/Widgets` matched a *property* named
 * `Widgets` on a type `C` and the annotation landed on the wrong element.
 */
describe('two-segment target disambiguation', () => {
  const csdl = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="C">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <Property Name="Widgets" Type="Edm.String" />
      </EntityType>
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <EntityContainer Name="C">
        <EntitySet Name="Widgets" EntityType="N.Widget" />
      </EntityContainer>
      <Annotations Target="C/Widgets">
        <Annotation Term="Core.Description" String="For the set" />
      </Annotations>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

  it('resolves an unqualified pair to the entity set, not the property', async () => {
    const model = await parseCSDL(csdl);
    const set = model.entityContainers[0]!.entitySets[0];
    const typeC = model.entities.find((e) => e.name === 'C')!;
    const property = typeC.properties.find((p) => p.name === 'Widgets')!;

    expect(set.annotations?.['Core.Description']).toBe('For the set');
    expect(property.annotations).toBeUndefined();
  });
});

/** Annotations apply to navigation properties too, not only structural ones. */
describe('navigation property targets', () => {
  it('annotates a navigation property', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="Parts" Type="Collection(N.Widget)" />
      </EntityType>
      <Annotations Target="N.Widget/Parts">
        <Annotation Term="Core.Description" String="The parts" />
      </Annotations>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);
    const nav = model.entities[0].navigationProperties[0];

    expect(nav.annotations?.['Core.Description']).toBe('The parts');
  });
});

/** The repo's own demo document is the fixture that exposed the qualified form. */
describe('odata-demo-metadata.xml', () => {
  it('applies every one of its targeted annotations', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const xml = readFileSync(
      fileURLToPath(new URL('../../../odata-demo-metadata.xml', import.meta.url)),
      'utf-8',
    );
    const model = await parseCSDL(xml);

    const suppliers = model.entityContainers[0]!.entitySets.find(
      (s) => s.name === 'Suppliers',
    )!;
    // `Target="ODataDemo.DemoService/Suppliers"` — the qualified container form.
    expect(suppliers.annotations).toBeDefined();

    const product = model.entities.find((e) => e.qualifiedName === 'ODataDemo.Product')!;
    expect(product.annotations).toBeDefined();
  });
});

/**
 * The same guard #25 added for type references applies to annotation targets: a
 * prefix that names an actual schema is a namespace, not an alias, so a target
 * must not be rewritten into another document's namespace.
 */
describe('target alias expansion respects real namespaces', () => {
  const csdl = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Y" Alias="Other" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
    </Schema>
    <Schema Namespace="Other" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Widget">
        <Key><PropertyRef Name="OtherId" /></Key>
        <Property Name="OtherId" Type="Edm.String" Nullable="false" />
      </EntityType>
      <Annotations Target="Other.Widget">
        <Annotation Term="Core.Description" String="The other one" />
      </Annotations>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

  it('does not rewrite a target whose prefix is a real schema', async () => {
    const model = await parseCSDL(csdl);
    const other = model.entities.find((e) => e.qualifiedName === 'Other.Widget')!;
    const y = model.entities.find((e) => e.qualifiedName === 'Y.Widget')!;

    // `Other` is a schema here, so the block targets it — not `Y.Widget` via
    // the `Alias="Other"` declared on the other schema.
    expect(other.annotations?.['Core.Description']).toBe('The other one');
    expect(y.annotations).toBeUndefined();
  });
});
