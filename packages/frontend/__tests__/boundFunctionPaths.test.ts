import { describe, it, expect } from 'vitest';
import { parseCSDL } from '@odata-visualizer/shared';
import {
  expandPath,
  findPaths,
  graphToExpandItems,
  graphToQueryState,
  isComposablePath,
  type TraversalPath,
} from '../src/utils/graphState';
import { buildODataQuery, getDefaultQuery, type QueryState } from '../src/utils/queryResolver';

/**
 * The issue's reproduction, plus a navigation property on the result type, a
 * parameterised bound function and a collection-bound one.
 */
const FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.01" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="A"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
      <EntityType Name="C"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="Related" Type="N.D" /></EntityType>
      <EntityType Name="D"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
      <Function Name="B" IsBound="true">
        <Parameter Name="it" Type="N.A" />
        <ReturnType Type="N.C" />
      </Function>
      <Function Name="WithParam" IsBound="true">
        <Parameter Name="it" Type="N.A" />
        <Parameter Name="limit" Type="Edm.Int32" />
        <ReturnType Type="N.C" />
      </Function>
      <Function Name="AllOf" IsBound="true">
        <Parameter Name="it" Type="Collection(N.A)" />
        <ReturnType Type="N.C" />
      </Function>
      <EntityContainer Name="C1">
        <EntitySet Name="As" EntityType="N.A" />
        <EntitySet Name="Cs" EntityType="N.C" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

async function model() {
  return parseCSDL(FIXTURE);
}

function functionPath(paths: TraversalPath[], name: string): TraversalPath {
  const match = paths.find(
    (p) => p[0].edge.kind === 'boundFunction' && p[0].edge.functionName === name,
  );
  expect(match, `path through ${name}`).toBeDefined();
  return match!;
}

describe('the pathfinder offers bound-function steps', () => {
  it('finds A -> B() -> C', async () => {
    const metadata = await model();
    const paths = findPaths('A', 'C', metadata);

    const path = functionPath(paths, 'B');
    expect(path).toHaveLength(1);
    expect(path[0]).toMatchObject({ from: 'A', to: 'C', edge: { kind: 'boundFunction' } });
  });

  it('marks the node with the step kind and keeps the function out of $expand', async () => {
    const metadata = await model();
    const state = expandPath('A', functionPath(findPaths('A', 'C', metadata), 'B'));

    const root = state.nodes.find((n) => n.id === 'root')!;
    const child = state.nodes.find((n) => n.parentId === 'root')!;

    expect(child.step?.edge).toMatchObject({ kind: 'boundFunction', functionName: 'B' });
    expect(child.navProperty).toBeNull();
    // A function is a segment, not an expansion.
    expect(root.expandedNavProps).toEqual([]);
    expect(state.edges[0]).toMatchObject({ label: 'B()', kind: 'boundFunction' });
  });

  it('never turns a function step into an expand item', async () => {
    const metadata = await model();
    const state = expandPath('A', functionPath(findPaths('A', 'C', metadata), 'B'));

    expect(graphToExpandItems(state, 'root')).toEqual([]);
  });

  it('hides a path whose function needs parameters', async () => {
    const metadata = await model();
    const paths = findPaths('A', 'C', metadata);

    expect(isComposablePath(functionPath(paths, 'B'))).toBe(true);
    expect(isComposablePath(functionPath(paths, 'WithParam'))).toBe(false);
  });

  it('hides a path whose function is not the first hop', async () => {
    const metadata = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.01" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="A"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="X" Type="N.X" /></EntityType>
      <EntityType Name="X"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
      <EntityType Name="C"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
      <Function Name="FromX" IsBound="true">
        <Parameter Name="it" Type="N.X" />
        <ReturnType Type="N.C" />
      </Function>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);
    const path = findPaths('A', 'C', metadata)[0];

    expect(path.map((s) => s.edge.kind)).toEqual(['nav', 'boundFunction']);
    expect(isComposablePath(path)).toBe(false);
  });
});

describe('the query builder emits the function segment', () => {
  function segmentQuery(overrides: Partial<QueryState> = {}): QueryState {
    return {
      entityName: 'C',
      sourceEntity: 'A',
      segment: {
        name: 'B',
        qualifiedName: 'N.B',
        parameters: [],
        bindingIsCollection: false,
        returnsCollection: false,
      },
      filters: [],
      filterLogic: 'and',
      select: [],
      expand: [],
      sort: '',
      sortDirection: 'asc',
      top: 0,
      skip: 0,
      ...overrides,
    };
  }

  it("emits /As('1')/N.B() and never puts the function in $expand", async () => {
    const metadata = await model();
    const url = buildODataQuery(segmentQuery({ select: ['Id'] }), metadata);

    expect(url).toBe("/As('1')/N.B()?$select=Id");
    expect(url).not.toMatch(/\$expand=[^&]*N\.B/);
  });

  it('applies $expand to the function result', async () => {
    const metadata = await model();
    const url = buildODataQuery(
      segmentQuery({
        expand: [
          {
            navProperty: 'Related',
            select: [],
            expand: [],
            filters: [],
            filterLogic: 'and',
            sort: '',
            sortDirection: 'asc',
            top: 0,
            skip: 0,
          },
        ],
      }),
      metadata,
    );

    expect(url).toBe("/As('1')/N.B()?$expand=Related");
    expect(url).not.toContain('N.B()?$expand=N.B');
  });

  it('needs no key when the function is bound to a collection', async () => {
    const metadata = await model();
    const url = buildODataQuery(
      segmentQuery({
        segment: {
          name: 'AllOf',
          qualifiedName: 'N.AllOf',
          parameters: [],
          bindingIsCollection: true,
          returnsCollection: false,
        },
        select: ['Id'],
      }),
      metadata,
    );

    expect(url).toBe('/As/N.AllOf()?$select=Id');
  });

  it('keeps nav-only queries unchanged', async () => {
    const metadata = await model();
    expect(buildODataQuery(getDefaultQuery('A'), metadata)).toBe('/As?$top=25');
  });

  it('composes a graph built from the found path into the segment URL', async () => {
    const metadata = await model();
    const state = expandPath('A', functionPath(findPaths('A', 'C', metadata), 'B'));
    const child = state.nodes.find((n) => n.parentId === 'root')!;
    const withSelect = {
      ...state,
      nodes: state.nodes.map((n) => (n.id === child.id ? { ...n, select: ['Id'] } : n)),
    };

    expect(buildODataQuery(graphToQueryState(withSelect, 'A'), metadata)).toBe(
      "/As('1')/N.B()?$select=Id",
    );
  });
});
