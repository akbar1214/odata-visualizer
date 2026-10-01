import { describe, it, expect } from 'vitest';
import { parseCSDL } from '@odata-visualizer/shared';
import {
  findEntity,
  getEntitySelectionValue,
  getResolvedEntity,
  getTargetEntityName,
} from '../src/utils/queryResolver';
import {
  addExpandedNode,
  createRootNode,
  findPaths,
  getReachableEntities,
} from '../src/utils/graphState';

/**
 * Two namespaces declare the same type names, and the navigation properties
 * cross the namespaces: `A.Widget.Docs` targets `B.Part`, while `B.Widget.Docs`
 * targets `A.Part`. A short-name lookup cannot tell the two `Part`s apart, so
 * every value the query UI stores or compares must be the entity's identity
 * (`qualified when the short name collides`) rather than the short name.
 *
 * `Note` is unique in the model and keeps the "short name while unique"
 * behaviour pinned.
 */
const ambiguousCsdl = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="A" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="Docs" Type="Collection(B.Part)" />
        <NavigationProperty Name="Notes" Type="Collection(A.Note)" />
      </EntityType>
      <EntityType Name="Part">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <Property Name="AOnly" Type="Edm.String" />
        <NavigationProperty Name="Owners" Type="Collection(A.Widget)" />
      </EntityType>
      <EntityType Name="Note">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
    </Schema>
    <Schema Namespace="B" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="Docs" Type="Collection(A.Part)" />
      </EntityType>
      <EntityType Name="Part">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="BOnly" Type="Edm.String" />
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="Owners" Type="Collection(B.Widget)" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

async function ambiguousModel() {
  return parseCSDL(ambiguousCsdl);
}

describe('getTargetEntityName with colliding short names', () => {
  it('returns the identity that resolves to the target, not the ambiguous short name', async () => {
    const model = await ambiguousModel();
    const aWidget = findEntity('A.Widget', model.entities)!;

    const target = getTargetEntityName('Docs', aWidget, model);

    // `Part` names two types, so it is not an identity.
    expect(target).toBe('B.Part');
    expect(findEntity(target!, model.entities)?.qualifiedName).toBe('B.Part');
  });

  it('keeps the short name while it is unique', async () => {
    const model = await ambiguousModel();
    const aWidget = findEntity('A.Widget', model.entities)!;

    expect(getTargetEntityName('Notes', aWidget, model)).toBe('Note');
  });
});

/**
 * V3 associations carry the qualified endpoint in `entityQualified`; resolution
 * must use it, and must compare the source end by identity rather than by the
 * short name.
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
        <Property Name="AOnly" Type="Edm.String" />
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
        <Property Name="BOnly" Type="Edm.String" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

describe('getTargetEntityName through a V3 association with colliding short names', () => {
  it('follows the qualified endpoint to its own namespace', async () => {
    const model = await parseCSDL(v3Csdl);
    const widget = findEntity('A.Widget', model.entities)!;

    const target = getTargetEntityName('Part', widget, model);

    expect(target).toBe('B.Part');
    expect(findEntity(target!, model.entities)?.properties.map((p) => p.name)).toContain('BOnly');
  });
});

describe('query graph identity', () => {
  it('stores the expanded target identity, not the ambiguous short name', async () => {
    const model = await ambiguousModel();
    const state = { nodes: [createRootNode('A.Widget')], edges: [] };

    const expanded = addExpandedNode(state, 'root', 'Docs', model);
    const child = expanded.nodes.find((n) => n.parentId === 'root')!;

    expect(child.entityName).toBe('B.Part');
    const resolved = getResolvedEntity(child.entityName, model.entities)!;
    expect(resolved.entity.qualifiedName).toBe('B.Part');
    expect(resolved.allProperties.map((p) => p.name)).toContain('BOnly');
  });

  it('expands again from the disambiguated child, staying in its namespace', async () => {
    const model = await ambiguousModel();
    const state = { nodes: [createRootNode('A.Widget')], edges: [] };
    const first = addExpandedNode(state, 'root', 'Docs', model);
    const child = first.nodes.find((n) => n.parentId === 'root')!;

    const second = addExpandedNode(first, child.id, 'Owners', model);
    const grandchild = second.nodes.find((n) => n.parentId === child.id)!;

    expect(grandchild.entityName).toBe('B.Widget');
    expect(findEntity(grandchild.entityName, model.entities)?.qualifiedName).toBe('B.Widget');
  });

  it('finds a path whose target is named by identity', async () => {
    const model = await ambiguousModel();

    const paths = findPaths('A.Widget', 'B.Part', model);

    expect(paths).toEqual([[{ fromEntity: 'A.Widget', navProperty: 'Docs', toEntity: 'B.Part' }]]);
  });

  it('reports reachable targets by the identity the dropdown offers', async () => {
    const model = await ambiguousModel();

    const reachable = getReachableEntities('A.Widget', model);
    const values = [...reachable.values()]
      .flat()
      .map((entry) => getEntitySelectionValue(entry.entity, model.entities));

    expect(values).toContain('B.Part');
    // The bare short name is not offered: it cannot say which `Part`.
    expect(values).not.toContain('Part');
  });
});

/**
 * `findEntity` matches case-insensitively and takes the first match, so a
 * short identity is not unique when two types differ only by case. The
 * ambiguity check compared names case-sensitively, so `part` was treated as
 * unique and the canvas resolved it to whichever `Part`/`part` was parsed
 * first — the same silent wrong-type class this PR exists to close.
 */
describe('a case-only collision is still an ambiguity', () => {
  const csdl = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="A" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="Docs" Type="Collection(B.part)" />
      </EntityType>
      <EntityType Name="Part">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
    </Schema>
    <Schema Namespace="B" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="part">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

  it('qualifies the identity rather than returning a short name that resolves elsewhere', async () => {
    const metadata = await parseCSDL(csdl);
    const widget = findEntity('A.Widget', metadata.entities)!;

    // `part` alone resolves to A.Part, which is a different type.
    expect(findEntity('part', metadata.entities)!.qualifiedName).toBe('A.Part');
    expect(getTargetEntityName('Docs', widget, metadata)).toBe('B.part');
  });
});
