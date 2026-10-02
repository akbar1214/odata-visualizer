import { describe, it, expect } from 'vitest';
import { parseCSDL, type ODataEntity } from '@odata-visualizer/shared';
import { layoutDiagram, filterMetadata } from '../src/utils/layout';

/**
 * Two entity types share the short name `Part` across namespaces, and `A.Part`
 * has two navigation properties to the same target — so every id the diagram
 * builds collides:
 *
 *   nodes: A.Part -> "Part",  B.Part -> "Part"        (one node disappears)
 *   edges: all three relationships -> "Part-Doc"      (edges collapse)
 *
 * Both were observed against the repo's Windchill fixture, which ships
 * `PTC.ProdMgmt.Part` and `net.example.common.Part`.
 */
const collidingCsdl = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="A" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Part">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="PrimaryDocs" Type="Collection(A.Doc)" />
        <NavigationProperty Name="SecondaryDocs" Type="Collection(A.Doc)" />
      </EntityType>
      <EntityType Name="Doc">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
    </Schema>
    <Schema Namespace="B" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Part">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="Docs" Type="Collection(A.Doc)" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

async function collidingModel() {
  return parseCSDL(collidingCsdl);
}

describe('layoutDiagram node ids', () => {
  it('keeps one node per type when two types share a short name', async () => {
    const model = await collidingModel();
    const { nodes } = await layoutDiagram(model);

    const ids = nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(['A.Doc', 'A.Part', 'B.Part']);
  });

  it('carries the entity through so the node can still be rendered', async () => {
    const model = await collidingModel();
    const { nodes } = await layoutDiagram(model);

    const bPart = nodes.find((n) => n.id === 'B.Part');
    const data = bPart?.data as { entity: ODataEntity } | undefined;
    expect(data?.entity.qualifiedName).toBe('B.Part');
  });

  it('gives ELK one child per node, so every node gets a real position', async () => {
    const model = await collidingModel();
    const { nodes } = await layoutDiagram(model);

    // A duplicate ELK child id leaves one node stranded at the origin. Asserting
    // "fewer than all" passed even with the bug, because one node still moved.
    const atOrigin = nodes.filter((n) => n.position.x === 0 && n.position.y === 0);
    expect(atOrigin).toHaveLength(0);
  });
});

describe('layoutDiagram edge ids', () => {
  it('gives parallel relationships between the same pair distinct edges', async () => {
    const model = await collidingModel();
    const { edges } = await layoutDiagram(model);

    const ids = edges.map((e) => e.id);
    // Length alone is true by construction; the collapse happens when React Flow
    // de-duplicates ids, so assert on uniqueness.
    expect(new Set(ids).size).toBe(model.relationships.length);
  });

  it('does not collapse relationships whose endpoints merely share a short name', async () => {
    const model = await collidingModel();
    const { edges } = await layoutDiagram(model);

    expect(edges).toHaveLength(model.relationships.length);
  });

  it('connects each edge to the node of its own namespace', async () => {
    const model = await collidingModel();
    const { nodes, edges } = await layoutDiagram(model);

    const nodeIds = new Set(nodes.map((n) => n.id));
    for (const edge of edges) {
      expect(nodeIds.has(edge.source), `missing source ${edge.source}`).toBe(true);
      expect(nodeIds.has(edge.target), `missing target ${edge.target}`).toBe(true);
    }

    // The `Part` end of each relationship resolves to the namespace that
    // declared it, not to whichever `Part` came first in the document.
    expect(edges.map((e) => e.source).sort()).toEqual(['A.Part', 'A.Part', 'B.Part']);
  });
});

describe('filterMetadata identity', () => {
  it('keeps a colliding type when it is named explicitly', async () => {
    const model = await collidingModel();
    const filtered = filterMetadata(model, { entityNames: ['B.Part'] });

    expect(filtered.entities.map((e) => e.qualifiedName)).toEqual(['B.Part']);
  });

  it('does not expand neighbours across namespaces', async () => {
    const model = await collidingModel();
    // `B.Part` relates only to `A.Doc`. The exact set matters: asserting "one of
    // the two Parts" would pass even if the wrong namespace leaked in.
    const filtered = filterMetadata(model, { search: 'B.Part' });

    expect(filtered.entities.map((e) => e.qualifiedName).sort()).toEqual(['A.Doc', 'B.Part']);
  });

  it('keeps only relationships whose endpoints survived the filter', async () => {
    const model = await collidingModel();
    const filtered = filterMetadata(model, { entityNames: ['B.Part'] });

    // B.Part -> A.Doc, but A.Doc was filtered out.
    expect(filtered.relationships).toHaveLength(0);
  });

  it('does not rebind a relationship to a survivor that merely shares its name', async () => {
    const model = await collidingModel();
    // Only `B.Part` and `A.Doc` survive, so only `B.Part`'s own relationship
    // belongs on the diagram. Indexing the *survivors* would make the short name
    // `Part` unique, rebind `A.Part`'s two relationships to `B.Part`, and draw
    // edges for a type that was filtered out.
    const filtered = filterMetadata(model, { entityNames: ['B.Part', 'A.Doc'] });

    expect(filtered.relationships.map((r) => r.name)).toEqual(['Part_Docs']);
  });
});

/**
 * Relationships record the declaring schema's namespace, which is the *source*
 * type's — applying it to the target picks the wrong type whenever the target
 * lives elsewhere and the short name also exists locally. The parser keeps the
 * qualified target, so resolution should use it rather than guess.
 */
describe('cross-namespace relationship targets', () => {
  const crossCsdl = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="A" xmlns="http://docs.oasis-open.org/odata/ns/edm">
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
    <Schema Namespace="B" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Doc">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

  it('resolves the target in its own namespace, not the declaring one', async () => {
    const model = await parseCSDL(crossCsdl);
    const { edges } = await layoutDiagram(model);

    // `A.Part.Docs` targets `B.Doc`. Namespace A also has a `Doc`, so guessing
    // from the relationship's namespace drew a self-consistent but wrong edge.
    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe('A.Part');
    expect(edges[0].target).toBe('B.Doc');
  });

  it('records the qualified target on the relationship', async () => {
    const model = await parseCSDL(crossCsdl);
    const [relationship] = model.relationships;
    expect(relationship.to.entityQualified).toBe('B.Doc');
    expect(relationship.from.entityQualified).toBe('A.Part');
  });
});
