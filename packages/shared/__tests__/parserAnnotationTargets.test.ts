import { describe, it, expect } from 'vitest';
import { parseCSDL } from '../src/parser.js';

/**
 * CSDL 4.01 §14.2.2 allows more target paths than `NS.Type`, `NS.Type/Prop`
 * and `Container/Set`. Every form below was silently dropped: the block parsed
 * and matched nothing, so annotations on actions, functions, enums, type
 * definitions, containers, singletons and imports could never be populated.
 *
 * The spec rules exercised here:
 *
 * - a structured type may be followed by property, navigation-property and
 *   type-cast segments;
 * - a container child may be followed by property and type-cast segments, and
 *   such an annotation **overrides** one targeted via the declaring type;
 * - an action/function may be followed by a parenthesised parameter-type list
 *   (empty for the unbound action overload) to select one overload, or nothing
 *   to select all of them;
 * - `NS.EnumType/Member` targets an enum member, `NS.TypeDefinition` a type
 *   definition, `NS.Container` the container itself, `Container/ActionImport`
 *   and `Container/FunctionImport` the imports.
 */
const types = `
      <ComplexType Name="Detail">
        <Property Name="Nested" Type="Edm.String" />
        <Property Name="Deep" Type="N.DeepDetail" />
      </ComplexType>
      <ComplexType Name="DeepDetail">
        <Property Name="Leaf" Type="Edm.String" />
      </ComplexType>
      <EntityType Name="Base">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <Property Name="BaseProp" Type="Edm.String" />
      </EntityType>
      <EntityType Name="Derived" BaseType="N.Base">
        <Property Name="DerivedProp" Type="Edm.String" />
      </EntityType>
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <Property Name="Name" Type="Edm.String" />
        <Property Name="Detail" Type="N.Detail" />
        <NavigationProperty Name="Parts" Type="Collection(N.Widget)" />
      </EntityType>
      <EnumType Name="Color">
        <Member Name="Red" />
        <Member Name="Blue" />
      </EnumType>
      <TypeDefinition Name="Money" UnderlyingType="Edm.Decimal" />
      <Action Name="Reset" />
      <Action Name="BoundReset" IsBound="true">
        <Parameter Name="it" Type="N.Widget" />
      </Action>
      <Function Name="Lookup">
        <Parameter Name="q" Type="Edm.String" />
        <ReturnType Type="Edm.String" />
      </Function>
      <Function Name="Lookup">
        <Parameter Name="q" Type="Edm.Int32" />
        <ReturnType Type="Edm.String" />
      </Function>
      <Function Name="Pick">
        <Parameter Name="c" Type="N.Color" />
        <ReturnType Type="Edm.String" />
      </Function>
      <EntityContainer Name="Container">
        <EntitySet Name="Widgets" EntityType="N.Widget" />
        <Singleton Name="Solo" Type="N.Widget" />
        <ActionImport Name="ResetImport" Action="N.Reset" />
        <FunctionImport Name="LookupImport" Function="N.Lookup" />
      </EntityContainer>`;

const csdl = (annotations: string) => `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.01" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" Alias="Self" xmlns="http://docs.oasis-open.org/odata/ns/edm">
${types}
${annotations}
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

const block = (target: string, description: string) => `
      <Annotations Target="${target}">
        <Annotation Term="Core.Description" String="${description}" />
      </Annotations>`;

function widgetProperty(model: Awaited<ReturnType<typeof parseCSDL>>, name: string) {
  return model.entities
    .find((e) => e.qualifiedName === 'N.Widget')!
    .properties.find((p) => p.name === name)!;
}

describe('nested property paths', () => {
  it('annotates a property of a complex property', async () => {
    const model = await parseCSDL(csdl(block('N.Widget/Detail/Nested', 'nested')));
    const nested = model.entities
      .find((e) => e.qualifiedName === 'N.Detail')!
      .properties.find((p) => p.name === 'Nested')!;

    expect(nested.annotations?.['Core.Description']).toBe('nested');
    expect(nested.label).toBe('nested');
  });

  it('walks more than one level of complex properties', async () => {
    const model = await parseCSDL(csdl(block('N.Widget/Detail/Deep/Leaf', 'deep')));
    const leaf = model.entities
      .find((e) => e.qualifiedName === 'N.DeepDetail')!
      .properties.find((p) => p.name === 'Leaf')!;

    expect(leaf.annotations?.['Core.Description']).toBe('deep');
  });

  it('annotates only the named nested property', async () => {
    const model = await parseCSDL(csdl(block('N.Widget/Detail/Nested', 'leaf only')));
    const detail = model.entities.find((e) => e.qualifiedName === 'N.Detail')!;

    expect(detail.properties.find((p) => p.name === 'Nested')!.annotations).toBeDefined();
    expect(detail.properties.find((p) => p.name === 'Deep')!.annotations).toBeUndefined();
  });
});

describe('type-cast segments', () => {
  it('annotates a base-type property through a derived type cast', async () => {
    const model = await parseCSDL(csdl(block('N.Derived/N.Base/BaseProp', 'via cast')));
    const base = model.entities
      .find((e) => e.qualifiedName === 'N.Base')!
      .properties.find((p) => p.name === 'BaseProp')!;

    expect(base.annotations?.['Core.Description']).toBe('via cast');
  });
});

describe('container-child-qualified property paths', () => {
  it('annotates a property through its entity set', async () => {
    const model = await parseCSDL(csdl(block('N.Container/Widgets/Name', 'via set')));

    expect(widgetProperty(model, 'Name').annotations?.['Core.Description']).toBe('via set');
  });

  it('overrides a type-qualified annotation declared later in the document', async () => {
    const model = await parseCSDL(
      csdl(block('N.Container/Widgets/Name', 'via set') + block('N.Widget/Name', 'via type')),
    );

    // §14.2.2: annotations on a property of an entity in a particular set
    // override annotations targeted via the declaring structured type.
    expect(widgetProperty(model, 'Name').label).toBe('via set');
  });

  it('overrides a type-qualified annotation declared earlier in the document', async () => {
    const model = await parseCSDL(
      csdl(block('N.Widget/Name', 'via type') + block('N.Container/Widgets/Name', 'via set')),
    );

    expect(widgetProperty(model, 'Name').label).toBe('via set');
  });

  it('annotates a navigation property through its entity set', async () => {
    const model = await parseCSDL(csdl(block('N.Container/Widgets/Parts', 'parts via set')));
    const parts = model.entities
      .find((e) => e.qualifiedName === 'N.Widget')!
      .navigationProperties.find((n) => n.name === 'Parts')!;

    expect(parts.annotations?.['Core.Description']).toBe('parts via set');
  });

  it('still lets an inline annotation win over a set-qualified one', async () => {
    const model = await parseCSDL(
      csdl(block('N.Container/Widgets/Name', 'via set')).replace(
        '<Property Name="Name" Type="Edm.String" />',
        `<Property Name="Name" Type="Edm.String">
          <Annotation Term="Core.Description" String="inline" />
        </Property>`,
      ),
    );

    expect(widgetProperty(model, 'Name').label).toBe('inline');
  });

  it('annotates a property through a singleton and overrides the type target', async () => {
    const model = await parseCSDL(
      csdl(block('N.Widget/Name', 'via type') + block('N.Container/Solo/Name', 'via singleton')),
    );

    expect(widgetProperty(model, 'Name').label).toBe('via singleton');
  });
});

describe('action and function targets', () => {
  it('annotates an action', async () => {
    const model = await parseCSDL(csdl(block('N.Reset', 'reset the model')));
    const action = model.actions.find((a) => a.name === 'Reset')!;

    expect(action.annotations?.['Core.Description']).toBe('reset the model');
    expect(action.label).toBe('reset the model');
  });

  it('annotates every overload of a function', async () => {
    const model = await parseCSDL(csdl(block('N.Lookup', 'lookup something')));
    const overloads = model.functions.filter((f) => f.name === 'Lookup');

    expect(overloads).toHaveLength(2);
    for (const overload of overloads) {
      expect(overload.annotations?.['Core.Description']).toBe('lookup something');
    }
  });

  it('selects a single function overload by parameter types', async () => {
    const model = await parseCSDL(csdl(block('N.Lookup(Edm.Int32)', 'int lookup')));
    const overloads = model.functions.filter((f) => f.name === 'Lookup');
    const intOverload = overloads.find((f) => f.parameters[0]?.type === 'Edm.Int32')!;
    const stringOverload = overloads.find((f) => f.parameters[0]?.type === 'Edm.String')!;

    expect(intOverload.annotations?.['Core.Description']).toBe('int lookup');
    expect(stringOverload.annotations).toBeUndefined();
  });

  it('selects the unbound action overload with empty parentheses', async () => {
    const model = await parseCSDL(csdl(block('N.Reset()', 'unbound overload')));

    expect(model.actions.find((a) => a.name === 'Reset')!.annotations?.['Core.Description']).toBe(
      'unbound overload',
    );
  });

  it('selects a bound action overload by its binding parameter type', async () => {
    const model = await parseCSDL(csdl(block('N.BoundReset(N.Widget)', 'bound overload')));
    const action = model.actions.find((a) => a.name === 'BoundReset')!;

    expect(action.annotations?.['Core.Description']).toBe('bound overload');
  });

  it('does not select a bound action overload with empty parentheses', async () => {
    const model = await parseCSDL(csdl(block('N.BoundReset()', 'not the bound one')));
    const action = model.actions.find((a) => a.name === 'BoundReset')!;

    expect(action.annotations).toBeUndefined();
  });

  it('expands aliases in the overload parameter list', async () => {
    const model = await parseCSDL(csdl(block('Self.Pick(Self.Color)', 'aliased overload')));
    const pick = model.functions.find((f) => f.name === 'Pick')!;

    expect(pick.annotations?.['Core.Description']).toBe('aliased overload');
  });

  it('falls back to a case-insensitive overload match', async () => {
    const model = await parseCSDL(csdl(block('N.Lookup(edm.int32)', 'sloppy overload')));
    const intOverload = model.functions.find(
      (f) => f.name === 'Lookup' && f.parameters[0]?.type === 'Edm.Int32',
    )!;
    const stringOverload = model.functions.find(
      (f) => f.name === 'Lookup' && f.parameters[0]?.type === 'Edm.String',
    )!;

    expect(intOverload.annotations?.['Core.Description']).toBe('sloppy overload');
    expect(stringOverload.annotations).toBeUndefined();
  });
});

describe('enum type and member targets', () => {
  it('annotates an enum type', async () => {
    const model = await parseCSDL(csdl(block('N.Color', 'the palette')));
    const color = model.enumTypes.find((e) => e.name === 'Color')!;

    expect(color.annotations?.['Core.Description']).toBe('the palette');
    expect(color.label).toBe('the palette');
  });

  it('annotates an enum member', async () => {
    const model = await parseCSDL(csdl(block('N.Color/Red', 'the red one')));
    const color = model.enumTypes.find((e) => e.name === 'Color')!;
    const red = color.members.find((m) => m.name === 'Red')!;

    expect(red.annotations?.['Core.Description']).toBe('the red one');
    expect(red.label).toBe('the red one');
    expect(color.annotations).toBeUndefined();
  });

  it('falls back to a case-insensitive enum member match', async () => {
    const model = await parseCSDL(csdl(block('n.color/red', 'sloppy member')));
    const color = model.enumTypes.find((e) => e.name === 'Color')!;

    expect(color.members.find((m) => m.name === 'Red')!.annotations?.['Core.Description']).toBe(
      'sloppy member',
    );
  });
});

describe('type definition and container targets', () => {
  it('annotates a type definition', async () => {
    const model = await parseCSDL(csdl(block('N.Money', 'currency amount')));
    const money = model.typeDefinitions.find((t) => t.name === 'Money')!;

    expect(money.annotations?.['Core.Description']).toBe('currency amount');
    expect(money.label).toBe('currency amount');
  });

  it('annotates the entity container itself', async () => {
    const model = await parseCSDL(csdl(block('N.Container', 'the service')));
    const container = model.entityContainers[0];

    expect(container.annotations?.['Core.Description']).toBe('the service');
    expect(container.label).toBe('the service');
  });

  it('annotates a singleton', async () => {
    const model = await parseCSDL(csdl(block('N.Container/Solo', 'the singleton')));
    const singleton = model.entityContainers[0].singletons![0];

    expect(singleton.name).toBe('Solo');
    expect(singleton.typeQualified).toBe('N.Widget');
    expect(singleton.annotations?.['Core.Description']).toBe('the singleton');
    expect(singleton.label).toBe('the singleton');
  });

  it('expands an aliased singleton type reference', async () => {
    const model = await parseCSDL(
      csdl('').replace(
        '<Singleton Name="Solo" Type="N.Widget" />',
        '<Singleton Name="Solo" Type="Self.Widget" />',
      ),
    );
    const singleton = model.entityContainers[0].singletons![0];

    expect(singleton.typeQualified).toBe('N.Widget');
    expect(singleton.type).toBe('Widget');
  });

  it('annotates an action import', async () => {
    const model = await parseCSDL(csdl(block('N.Container/ResetImport', 'reset import')));
    const importRecord = model.actionImports.find((a) => a.name === 'ResetImport')!;

    expect(importRecord.annotations?.['Core.Description']).toBe('reset import');
    expect(importRecord.label).toBe('reset import');
  });

  it('annotates a function import', async () => {
    const model = await parseCSDL(csdl(block('N.Container/LookupImport', 'lookup import')));
    const importRecord = model.functionImports.find((f) => f.name === 'LookupImport')!;

    expect(importRecord.annotations?.['Core.Description']).toBe('lookup import');
    expect(importRecord.label).toBe('lookup import');
  });

  it('falls back to a case-insensitive action match', async () => {
    const model = await parseCSDL(csdl(block('n.reset', 'sloppy action')));
    const action = model.actions.find((a) => a.name === 'Reset')!;

    expect(action.annotations?.['Core.Description']).toBe('sloppy action');
  });

  it('falls back to a case-insensitive singleton match', async () => {
    const model = await parseCSDL(csdl(block('n.container/solo', 'sloppy singleton')));
    const singleton = model.entityContainers[0].singletons![0];

    expect(singleton.annotations?.['Core.Description']).toBe('sloppy singleton');
  });

  it('falls back to a case-insensitive import match', async () => {
    const model = await parseCSDL(csdl(block('n.container/resetimport', 'sloppy import')));
    const importRecord = model.actionImports.find((a) => a.name === 'ResetImport')!;

    expect(importRecord.annotations?.['Core.Description']).toBe('sloppy import');
  });

  it('resolves a set\u2019s unqualified entity type in the container\u2019s namespace', async () => {
    const model = await parseCSDL(
      csdl('')
        .replace(
          '<EntitySet Name="Widgets" EntityType="N.Widget" />',
          '<EntitySet Name="Widgets" EntityType="Widget" />',
        )
        .replace(
          '</EntityContainer>',
          `</EntityContainer>${block('N.Container/Widgets/Name', 'unqualified set type')}`,
        ),
    );

    expect(widgetProperty(model, 'Name').annotations?.['Core.Description']).toBe(
      'unqualified set type',
    );
  });

  it('prefers the container\u2019s namespace when an unqualified set type collides', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="A" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <Property Name="Name" Type="Edm.String" />
      </EntityType>
      <EntityContainer Name="C">
        <EntitySet Name="Widgets" EntityType="Widget" />
      </EntityContainer>
    </Schema>
    <Schema Namespace="B" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <Property Name="Name" Type="Edm.String" />
      </EntityType>
      <Annotations Target="A.C/Widgets/Name">
        <Annotation Term="Core.Description" String="A\u2019s widget" />
      </Annotations>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);
    const aWidget = model.entities.find((e) => e.qualifiedName === 'A.Widget')!;
    const bWidget = model.entities.find((e) => e.qualifiedName === 'B.Widget')!;

    // The set's unqualified `EntityType="Widget"` means the container's own
    // namespace, not the namespace of the block that annotates it.
    expect(
      aWidget.properties.find((p) => p.name === 'Name')!.annotations?.['Core.Description'],
    ).toBe('A\u2019s widget');
    expect(bWidget.properties.find((p) => p.name === 'Name')!.annotations).toBeUndefined();
  });

  it('does not apply an import target to a same-named import in another container', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <Action Name="Reset" />
      <EntityContainer Name="First">
        <ActionImport Name="ResetImport" Action="N.Reset" />
      </EntityContainer>
      <EntityContainer Name="Second">
        <ActionImport Name="ResetImport" Action="N.Reset" />
      </EntityContainer>
      <Annotations Target="N.Second/ResetImport">
        <Annotation Term="Core.Description" String="second only" />
      </Annotations>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);

    expect(model.actionImports.find((a) => a.container === 'N.First')!.annotations).toBeUndefined();
    expect(
      model.actionImports.find((a) => a.container === 'N.Second')!.annotations?.[
        'Core.Description'
      ],
    ).toBe('second only');
  });

  it('derives labels from inline annotations on the newly targetable kinds', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <EnumType Name="Color">
        <Member Name="Red">
          <Annotation Term="Core.Description" String="member label" />
        </Member>
        <Annotation Term="Core.Description" String="enum label" />
      </EnumType>
      <TypeDefinition Name="Money" UnderlyingType="Edm.Decimal">
        <Annotation Term="Core.Description" String="type definition label" />
      </TypeDefinition>
      <Action Name="Reset">
        <Annotation Term="Core.Description" String="action label" />
      </Action>
      <Function Name="Lookup">
        <Parameter Name="q" Type="Edm.String" />
        <Annotation Term="Core.Description" String="function label" />
      </Function>
      <EntityContainer Name="Container">
        <EntitySet Name="Widgets" EntityType="N.Widget" />
        <Singleton Name="Solo" Type="N.Widget">
          <Annotation Term="Core.Description" String="singleton label" />
        </Singleton>
        <ActionImport Name="ResetImport" Action="N.Reset">
          <Annotation Term="Core.Description" String="action import label" />
        </ActionImport>
        <FunctionImport Name="LookupImport" Function="N.Lookup">
          <Annotation Term="Core.Description" String="function import label" />
        </FunctionImport>
        <Annotation Term="Core.Description" String="container label" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);

    expect(model.enumTypes[0].label).toBe('enum label');
    expect(model.enumTypes[0].members[0].label).toBe('member label');
    expect(model.typeDefinitions[0].label).toBe('type definition label');
    expect(model.actions[0].label).toBe('action label');
    expect(model.functions[0].label).toBe('function label');
    expect(model.entityContainers[0].label).toBe('container label');
    expect(model.entityContainers[0].singletons![0].label).toBe('singleton label');
    expect(model.actionImports[0].label).toBe('action import label');
    expect(model.functionImports[0].label).toBe('function import label');
  });
});

describe('targets that stay unsupported', () => {
  it('ignores a parameter target rather than attaching it elsewhere', async () => {
    const model = await parseCSDL(csdl(block('N.BoundReset/it', 'a parameter')));

    // `ODataParameter` has no annotations field; the block must not fall
    // through to the action itself.
    expect(model.actions.find((a) => a.name === 'BoundReset')!.annotations).toBeUndefined();
  });

  it('ignores a return-type target', async () => {
    const model = await parseCSDL(csdl(block('N.Lookup/$ReturnType', 'a return type')));

    for (const overload of model.functions.filter((f) => f.name === 'Lookup')) {
      expect(overload.annotations).toBeUndefined();
    }
  });

  it('ignores a target whose container child is unknown', async () => {
    const model = await parseCSDL(csdl(block('N.Container/Missing', 'nowhere')));

    expect(model.entityContainers[0].annotations).toBeUndefined();
  });
});

/**
 * Every qualified name in a target path is in scope, so an alias can appear in
 * a *cast* segment, not just the first one. Expanding the whole string reached
 * only the leading segment, so `N.Derived/Self.Base/BaseProp` resolved to
 * nothing while `N.Derived/N.Base/BaseProp` worked — a silent drop in the one
 * form this file is about.
 *
 * The second case is the same shape: an inherited property is part of the
 * derived type everywhere else in this parser, so a target path naming one
 * resolves rather than requiring an explicit cast.
 */
describe('cast segments written with an alias, and inherited properties', () => {
  const csdl = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" Alias="Self" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Base">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <Property Name="BaseProp" Type="Edm.String" />
      </EntityType>
      <EntityType Name="Derived" BaseType="N.Base" />
      <Annotations Target="N.Derived/Self.Base/BaseProp">
        <Annotation Term="Core.Description" String="aliased cast" />
      </Annotations>
      <Annotations Target="N.Derived/BaseProp">
        <Annotation Term="T.Inherited" String="inherited" />
      </Annotations>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

  const baseProp = (model: Awaited<ReturnType<typeof parseCSDL>>) =>
    model.entities
      .find((e) => e.qualifiedName === 'N.Base')!
      .properties.find((p) => p.name === 'BaseProp')!;

  it('expands an alias in a type-cast segment', async () => {
    const model = await parseCSDL(csdl);

    expect(baseProp(model).annotations?.['Core.Description']).toBe('aliased cast');
  });

  it('resolves a property inherited from a base type', async () => {
    const model = await parseCSDL(csdl);

    expect(baseProp(model).annotations?.['T.Inherited']).toBe('inherited');
  });
});
