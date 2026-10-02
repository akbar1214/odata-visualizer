import { describe, it, expect } from 'vitest';
import { parseCSDL } from '@odata-visualizer/shared';
import {
  expandPath,
  findPaths,
  functionStepWarnings,
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
      <EntityType Name="E"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.Int32" Nullable="false" /></EntityType>
      <EntityType Name="M"><Key><PropertyRef Name="Num" /><PropertyRef Name="Code" /></Key>
        <Property Name="Num" Type="Edm.Int32" Nullable="false" />
        <Property Name="Code" Type="Edm.String" Nullable="false" /></EntityType>
      <Function Name="FromE" IsBound="true">
        <Parameter Name="it" Type="N.E" />
        <ReturnType Type="N.C" />
      </Function>
      <Function Name="FromM" IsBound="true">
        <Parameter Name="it" Type="N.M" />
        <ReturnType Type="N.C" />
      </Function>
      <EntityContainer Name="C1">
        <EntitySet Name="As" EntityType="N.A" />
        <EntitySet Name="Cs" EntityType="N.C" />
        <EntitySet Name="Es" EntityType="N.E" />
        <EntitySet Name="Ms" EntityType="N.M" />
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

  it('reports a function step that is not the first hop as dropped', async () => {
    // The UI cannot select this path, but a forced mixed state can still hold
    // it; `graphToQueryState` only composes a function at the root, so the
    // step is absent from the query and must be reported rather than lost.
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
      <EntityContainer Name="C1">
        <EntitySet Name="As" EntityType="N.A" />
        <EntitySet Name="Cs" EntityType="N.C" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);
    const path = findPaths('A', 'C', metadata)[0];
    const state = expandPath('A', path);

    // The query keeps the navigation expansion and loses the function...
    expect(buildODataQuery(graphToQueryState(state, 'A'), metadata)).toBe('/As?$expand=X&$top=25');
    // ...and the projection says so instead of dropping it silently.
    expect(functionStepWarnings(state)).toEqual([
      'The bound function FromX() is not part of the query: a function can only be the first step of the resource path.',
    ]);
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

  it('types the placeholder key from the key property, so an Int32 key is (1)', async () => {
    const metadata = await model();
    const warnings: string[] = [];
    const url = buildODataQuery(
      segmentQuery({
        sourceEntity: 'E',
        segment: {
          name: 'FromE',
          qualifiedName: 'N.FromE',
          parameters: [],
          bindingIsCollection: false,
          returnsCollection: false,
        },
      }),
      metadata,
      (message) => warnings.push(message),
    );

    expect(url).toBe('/Es(1)/N.FromE()');
    expect(warnings).toEqual([
      "The preview uses key placeholder '1' on E; replace it with a real key.",
    ]);
  });

  it('types every property of a composite key predicate', async () => {
    const metadata = await model();
    const url = buildODataQuery(
      segmentQuery({
        sourceEntity: 'M',
        segment: {
          name: 'FromM',
          qualifiedName: 'N.FromM',
          parameters: [],
          bindingIsCollection: false,
          returnsCollection: false,
        },
      }),
      metadata,
    );

    expect(url).toBe("/Ms(Num=1,Code='1')/N.FromM()");
  });

  it('encodes a hostile composite key name instead of letting it reshape the predicate', async () => {
    const metadata = await model();
    const m = metadata.entities.find((e) => e.name === 'M')!;
    // A metadata key name is data, not syntax: raw, `)` closes the predicate
    // and `=1 or (1` turns the placeholder tail into a second expression the
    // server reads as structure. `encodeIdentifierForUrl` is the shared policy
    // for names in path positions — the same one MCP uses for key names — and
    // unlike `assertResourceSegment` it also refuses a `/` inside the name
    // rather than accepting it as a path separator.
    m.keys[1] = 'Evil)=1 or (1';
    const url = buildODataQuery(
      segmentQuery({
        sourceEntity: 'M',
        segment: {
          name: 'FromM',
          qualifiedName: 'N.FromM',
          parameters: [],
          bindingIsCollection: false,
          returnsCollection: false,
        },
      }),
      metadata,
    );

    expect(url).toBe("/Ms(Num=1,Evil%29%3D1%20or%20%281='1')/N.FromM()");
  });

  it('says a keyless type cannot be addressed rather than asking for a key', async () => {
    const keyless = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.01" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="K"><Property Name="Name" Type="Edm.String" /></EntityType>
      <Function Name="FromK" IsBound="true">
        <Parameter Name="it" Type="N.K" />
        <ReturnType Type="N.K" />
      </Function>
      <EntityContainer Name="C1"><EntitySet Name="Ks" EntityType="N.K" /></EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);
    const warnings: string[] = [];
    const url = buildODataQuery(
      segmentQuery({
        entityName: 'K',
        sourceEntity: 'K',
        segment: {
          name: 'FromK',
          qualifiedName: 'N.FromK',
          parameters: [],
          bindingIsCollection: false,
          returnsCollection: false,
        },
      }),
      keyless,
      (message) => warnings.push(message),
    );

    expect(url).toBe("/Ks('1')/N.FromK()");
    expect(warnings).toEqual([
      "K declares no key, so no single-entity path can be built; the placeholder '1' sketches the shape only.",
    ]);
  });

  it('refuses an invalid qualified function name with one warning naming the failure', async () => {
    const metadata = await model();
    const warnings: string[] = [];
    const url = buildODataQuery(
      segmentQuery({
        segment: {
          name: 'B',
          qualifiedName: 'N.B?evil=1',
          parameters: [],
          bindingIsCollection: false,
          returnsCollection: false,
        },
      }),
      metadata,
      (message) => warnings.push(message),
    );

    // The placeholder note used to be emitted before the assertion refused the
    // name, so one problem produced two warnings — the first describing a
    // preview that was never built. The refusal is the only thing to say, and
    // since no path survives, it must not claim the preview shows one.
    expect(url).toBe('');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Invalid entitySet');
    expect(warnings[0]).toContain('so the preview shows no query');
  });

  it('refuses a segment whose function needs parameter values', async () => {
    // The UI gates this shape out, but `buildODataQuery` is public: a caller
    // that hands over a `WithParam` state must be refused, not answered with
    // a call that silently omits the required parameter.
    const metadata = await model();
    const warnings: string[] = [];
    const url = buildODataQuery(
      segmentQuery({
        segment: {
          name: 'WithParam',
          qualifiedName: 'N.WithParam',
          parameters: [{ name: 'limit', type: 'Edm.Int32' }],
          bindingIsCollection: false,
          returnsCollection: false,
        },
      }),
      metadata,
      (message) => warnings.push(message),
    );

    expect(url).toBe('');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('requires parameter values');
  });

  it('warns when root options are dropped because a function owns the path', async () => {
    const metadata = await model();
    const base = expandPath('A', functionPath(findPaths('A', 'C', metadata), 'B'));
    const state = {
      ...base,
      nodes: base.nodes.map((n) =>
        n.id === 'root'
          ? { ...n, top: 7, filters: [{ property: 'Id', operator: 'eq', value: '1' }] }
          : n,
      ),
    };

    // The root options are not representable before the invocation...
    expect(buildODataQuery(graphToQueryState(state, 'A'), metadata)).toBe("/As('1')/N.B()");
    // ...so the projection reports them rather than dropping them silently.
    expect(functionStepWarnings(state)).toEqual([
      "The root card's options are not part of the query: the resource path invokes a bound function, so only the function result card's options apply.",
    ]);
  });

  it('stays quiet about root options when the path has no function', () => {
    const state = expandPath('A', []);
    const withTop = {
      ...state,
      nodes: state.nodes.map((n) => (n.id === 'root' ? { ...n, top: 7 } : n)),
    };

    expect(functionStepWarnings(withTop)).toEqual([]);
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
