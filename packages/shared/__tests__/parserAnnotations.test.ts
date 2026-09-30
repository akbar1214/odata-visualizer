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
