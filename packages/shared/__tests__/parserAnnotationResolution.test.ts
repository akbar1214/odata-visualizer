import { describe, it, expect } from 'vitest';
import { parseCSDL } from '../src/parser.js';

/**
 * Resolution and precedence rules for schema-level `<Annotations Target="...">`
 * blocks.
 *
 * The parser applies every block after the whole model is parsed, so several
 * blocks can reach the same element. Each test below pins one of the rules the
 * resolver settled on:
 *
 * - a bare target resolves in the schema that declares the block first, and
 *   only falls back to the rest of the model when that schema has no match;
 * - among targeted blocks, the last one in document order wins — matching the
 *   within-block rule — while an inline annotation still wins over all of them;
 * - lookups follow the project-wide case policy: an exact-case match wins, a
 *   case-insensitive match is only the fallback;
 * - a block carrying `Qualifier` is rejected rather than attached unqualified,
 *   because `Record<term, string>` cannot represent it.
 */
const twoSchemasSameShortName = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="PTC.ProdMgmt" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Part">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <Annotations Target="Part">
        <Annotation Term="Core.Description" String="from PTC.ProdMgmt" />
      </Annotations>
    </Schema>
    <Schema Namespace="net.example.common" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Part">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <Annotations Target="Part">
        <Annotation Term="Core.Description" String="from net.example.common" />
      </Annotations>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

describe('a bare target resolves in its declaring schema', () => {
  it('attaches each bare target to its own schema\u2019s type', async () => {
    const model = await parseCSDL(twoSchemasSameShortName);
    const prodMgmt = model.entities.find((e) => e.qualifiedName === 'PTC.ProdMgmt.Part')!;
    const common = model.entities.find((e) => e.qualifiedName === 'net.example.common.Part')!;

    // Both schemas declare a `Part`; `findEntityByName` alone returns the first
    // in document order, so the second block used to land on the first type.
    expect(prodMgmt.annotations?.['Core.Description']).toBe('from PTC.ProdMgmt');
    expect(prodMgmt.label).toBe('from PTC.ProdMgmt');
    expect(common.annotations?.['Core.Description']).toBe('from net.example.common');
    expect(common.label).toBe('from net.example.common');
  });

  it('still resolves a bare target that only exists in another schema', async () => {
    // Lenient input: CSDL requires qualification, but hand-written documents
    // use short names, and a block may name a type from a loaded reference.
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="A" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <Annotations Target="OnlyOverThere">
        <Annotation Term="Core.Description" String="cross-schema" />
      </Annotations>
    </Schema>
    <Schema Namespace="B" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="OnlyOverThere">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);
    const entity = model.entities[0];

    expect(entity.annotations?.['Core.Description']).toBe('cross-schema');
  });

  it('prefers a bare entity-set target in the declaring schema too', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="A" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <EntityContainer Name="A_Container">
        <EntitySet Name="Widgets" EntityType="A.Widget" />
      </EntityContainer>
      <Annotations Target="Widgets">
        <Annotation Term="Core.Description" String="from A" />
      </Annotations>
    </Schema>
    <Schema Namespace="B" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <EntityContainer Name="B_Container">
        <EntitySet Name="Widgets" EntityType="B.Widget" />
      </EntityContainer>
      <Annotations Target="Widgets">
        <Annotation Term="Core.Description" String="from B" />
      </Annotations>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);
    const [a, b] = model.entityContainers.map((c) => c.entitySets[0]);

    expect(a.annotations?.['Core.Description']).toBe('from A');
    expect(b.annotations?.['Core.Description']).toBe('from B');
  });

  it('prefers a bare container segment in the declaring schema', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="A" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <EntityContainer Name="C">
        <EntitySet Name="Widgets" EntityType="A.Widget" />
      </EntityContainer>
      <Annotations Target="C/Widgets">
        <Annotation Term="Core.Description" String="from A" />
      </Annotations>
    </Schema>
    <Schema Namespace="B" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <EntityContainer Name="C">
        <EntitySet Name="Widgets" EntityType="B.Widget" />
      </EntityContainer>
      <Annotations Target="C/Widgets">
        <Annotation Term="Core.Description" String="from B" />
      </Annotations>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);
    const [a, b] = model.entityContainers.map((c) => c.entitySets[0]);

    expect(a.annotations?.['Core.Description']).toBe('from A');
    expect(b.annotations?.['Core.Description']).toBe('from B');
  });

  it('prefers the exact-case qualified container name', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
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
    </Schema>
    <Schema Namespace="n" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityContainer Name="container">
        <EntitySet Name="Widgets" EntityType="N.Widget" />
      </EntityContainer>
      <Annotations Target="n.container/Widgets">
        <Annotation Term="Core.Description" String="lowercase container" />
      </Annotations>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);
    const [upper, lower] = model.entityContainers.map((c) => c.entitySets[0]);

    expect(lower.annotations?.['Core.Description']).toBe('lowercase container');
    expect(upper.annotations).toBeUndefined();
  });
});

describe('a qualified Annotations block', () => {
  const widget = `
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>`;
  const wrap = (blocks: string) => `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
${widget}
${blocks}
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

  it('is rejected instead of collapsing two qualifiers into one value', async () => {
    const model = await parseCSDL(
      wrap(`
      <Annotations Target="N.Widget" Qualifier="Tablet">
        <Annotation Term="Core.Description" String="tablet" />
      </Annotations>
      <Annotations Target="N.Widget" Qualifier="Phone">
        <Annotation Term="Core.Description" String="phone" />
      </Annotations>`),
    );
    const entity = model.entities[0];

    // `Record<term, string>` cannot represent the qualifier, and attaching
    // either value as if it were unqualified is silently wrong.
    expect(entity.annotations).toBeUndefined();
    expect(entity.label).toBeUndefined();
  });

  it('does not overwrite an unqualified block that precedes it', async () => {
    const model = await parseCSDL(
      wrap(`
      <Annotations Target="N.Widget">
        <Annotation Term="Core.Description" String="unqualified" />
      </Annotations>
      <Annotations Target="N.Widget" Qualifier="Tablet">
        <Annotation Term="Core.Description" String="tablet" />
      </Annotations>`),
    );

    expect(model.entities[0].annotations?.['Core.Description']).toBe('unqualified');
  });

  it('does not overwrite an unqualified block that follows it', async () => {
    const model = await parseCSDL(
      wrap(`
      <Annotations Target="N.Widget" Qualifier="Tablet">
        <Annotation Term="Core.Description" String="tablet" />
      </Annotations>
      <Annotations Target="N.Widget">
        <Annotation Term="Core.Description" String="unqualified" />
      </Annotations>`),
    );

    expect(model.entities[0].annotations?.['Core.Description']).toBe('unqualified');
  });

  it('rejects a qualified Annotation element inside an unqualified block', async () => {
    const model = await parseCSDL(
      wrap(`
      <Annotations Target="N.Widget">
        <Annotation Term="Core.Description" String="plain" />
        <Annotation Term="Core.Description" Qualifier="Tablet" String="tablet" />
      </Annotations>`),
    );

    // Same representation limit one level down: the qualified annotation is
    // not the unqualified `Core.Description`, so it must not be stored as one.
    // It is declared last, so a parser that merely flattens would keep it.
    expect(model.entities[0].annotations?.['Core.Description']).toBe('plain');
  });

  it('rejects a block whose only annotation is qualified', async () => {
    const model = await parseCSDL(
      wrap(`
      <Annotations Target="N.Widget">
        <Annotation Term="Core.Description" Qualifier="Tablet" String="tablet" />
      </Annotations>`),
    );

    expect(model.entities[0].annotations).toBeUndefined();
  });
});

describe('targeted merge precedence', () => {
  const widget = `
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>`;

  it('lets the last block in document order win', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
${widget}
      <Annotations Target="N.Widget">
        <Annotation Term="Core.Description" String="first block" />
      </Annotations>
      <Annotations Target="N.Widget">
        <Annotation Term="Core.Description" String="second block" />
      </Annotations>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);

    // The within-block rule is last-wins, so peer blocks use the same rule.
    expect(model.entities[0].annotations?.['Core.Description']).toBe('second block');
    expect(model.entities[0].label).toBe('second block');
  });

  it('lets a later schema\u2019s block win over an earlier schema\u2019s', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="A" xmlns="http://docs.oasis-open.org/odata/ns/edm">
${widget}
      <Annotations Target="A.Widget">
        <Annotation Term="Core.Description" String="from A" />
      </Annotations>
    </Schema>
    <Schema Namespace="B" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <Annotations Target="A.Widget">
        <Annotation Term="Core.Description" String="from B" />
      </Annotations>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);

    expect(model.entities[0].annotations?.['Core.Description']).toBe('from B');
  });

  it('keeps last-wins within a single block', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
${widget}
      <Annotations Target="N.Widget">
        <Annotation Term="Core.Description" String="first annotation" />
        <Annotation Term="Core.Description" String="last annotation" />
      </Annotations>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);

    expect(model.entities[0].annotations?.['Core.Description']).toBe('last annotation');
  });
});

describe('target lookups follow the exact-case-first policy', () => {
  const csdl = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <Property Name="Name" Type="Edm.String" />
        <Property Name="name" Type="Edm.String" />
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Widgets" EntityType="N.Widget" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

  it('prefers the exact-case property when two differ only by case', async () => {
    const model = await parseCSDL(
      csdl.replace(
        '</Schema>',
        `  <Annotations Target="N.Widget/Name">
        <Annotation Term="Core.Description" String="upper" />
      </Annotations>
      <Annotations Target="n.widget/name">
        <Annotation Term="Core.Description" String="lower" />
      </Annotations>
</Schema>`,
      ),
    );
    const entity = model.entities[0];
    const upper = entity.properties.find((p) => p.name === 'Name')!;
    const lower = entity.properties.find((p) => p.name === 'name')!;

    // Each spelling reaches its own property rather than the first in
    // document order.
    expect(upper.annotations?.['Core.Description']).toBe('upper');
    expect(lower.annotations?.['Core.Description']).toBe('lower');
  });

  it('falls back to a case-insensitive property match', async () => {
    const model = await parseCSDL(
      csdl.replace(
        '</Schema>',
        `  <Annotations Target="N.Widget/NAME">
        <Annotation Term="Core.Description" String="sloppy spelling" />
      </Annotations>
</Schema>`,
      ),
    );
    const property = model.entities[0].properties.find((p) => p.name === 'Name')!;

    // Nothing is spelled `NAME`, so the fallback applies.
    expect(property.annotations?.['Core.Description']).toBe('sloppy spelling');
    expect(property.label).toBe('sloppy spelling');
  });

  it('falls back to a case-insensitive container and set match', async () => {
    const model = await parseCSDL(
      csdl.replace(
        '</Schema>',
        `  <Annotations Target="n.container/widgets">
        <Annotation Term="Core.Description" String="all widgets" />
      </Annotations>
</Schema>`,
      ),
    );
    const set = model.entityContainers[0].entitySets[0];

    expect(set.annotations?.['Core.Description']).toBe('all widgets');
    expect(set.label).toBe('all widgets');
  });

  it('prefers the exact-case set when two differ only by case', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Widgets" EntityType="N.Widget" />
        <EntitySet Name="WIDGETS" EntityType="N.Widget" />
      </EntityContainer>
      <Annotations Target="Container/WIDGETS">
        <Annotation Term="Core.Description" String="upper set" />
      </Annotations>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);
    const sets = model.entityContainers[0].entitySets;

    expect(sets.find((s) => s.name === 'WIDGETS')!.annotations?.['Core.Description']).toBe(
      'upper set',
    );
    expect(sets.find((s) => s.name === 'Widgets')!.annotations).toBeUndefined();
  });
});

describe('annotation labels are derived consistently', () => {
  it('derives the label of a targeted property', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <Property Name="Name" Type="Edm.String" />
      </EntityType>
      <Annotations Target="N.Widget/Name">
        <Annotation Term="Core.Description" String="The widget name" />
      </Annotations>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);
    const property = model.entities[0].properties.find((p) => p.name === 'Name')!;

    // A mutation that deletes `property.label = ...` survived the suite before.
    expect(property.label).toBe('The widget name');
  });

  it('derives the label of an inline entity-set annotation', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Widgets" EntityType="N.Widget">
          <Annotation Term="Core.Description" String="All widgets" />
        </EntitySet>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);
    const set = model.entityContainers[0].entitySets[0];

    // `parseEntitySet` set `annotations` but never `label`, unlike every other
    // parse function and unlike `applyTargetedAnnotations`.
    expect(set.annotations?.['Core.Description']).toBe('All widgets');
    expect(set.label).toBe('All widgets');
  });

  it('derives the label of an inline action annotation', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <Action Name="Reset">
        <Annotation Term="Core.Description" String="Resets the model" />
      </Action>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);
    const action = model.actions[0];

    // `ODataAction.label` exists and MCP renders it, but only entities,
    // properties and navigation properties derived it from inline
    // annotations.
    expect(action.annotations?.['Core.Description']).toBe('Resets the model');
    expect(action.label).toBe('Resets the model');
  });
});

/**
 * The attribute spelling of a qualifier. Non-conformant for XML CSDL, but it
 * used to land in the map under a mangled key (`Core.Description#Phone`) while
 * the canonical `Qualifier="Phone"` spelling was rejected — an inconsistency in
 * a policy the resolver describes as complete.
 */
describe('a hash-qualified term is rejected like the qualifier attribute', () => {
  it('does not store the mangled term', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <Annotation Term="Core.Description#Phone" String="hash-term" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);
    const widget = model.entities.find((e) => e.qualifiedName === 'N.Widget')!;

    expect(widget.annotations).toBeUndefined();
  });
});
