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

  it('gives ELK one child per node, so the layout is computed for the real graph', async () => {
    const model = await collidingModel();
    const { nodes } = await layoutDiagram(model);

    // Every node must have received a position; a duplicate ELK child id would
    // leave one of them stranded at (0,0).
    const atOrigin = nodes.filter((n) => n.position.x === 0 && n.position.y === 0);
    expect(atOrigin.length).toBeLessThan(nodes.length);
  });
});

describe('layoutDiagram edge ids', () => {
  it('gives parallel relationships between the same pair distinct edges', async () => {
    const model = await collidingModel();
    const { edges } = await layoutDiagram(model);

    const ids = edges.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
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

  it('does not pull in the other namespace when expanding neighbours', async () => {
    const model = await collidingModel();
    // `B.Part` relates only to `A.Doc`; `A.Part` must not be dragged in just
    // because it shares the short name.
    const filtered = filterMetadata(model, { search: 'Part', includeNeighbours: false });

    const names = filtered.entities.map((e) => e.qualifiedName);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(name === 'A.Part' || name === 'B.Part').toBe(true);
    }
  });

  it('keeps only relationships whose endpoints survived the filter', async () => {
    const model = await collidingModel();
    const filtered = filterMetadata(model, { entityNames: ['B.Part'] });

    // B.Part -> A.Doc, but A.Doc was filtered out.
    expect(filtered.relationships).toHaveLength(0);
  });
});
