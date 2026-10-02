import { describe, it, expect } from 'vitest';
import { parseCSDL } from '../src/parser.js';
import type { ODataMetadata } from '../src/types.js';
import {
  findPaths,
  getReachableEntities,
  getSuccessorEdges,
  getTraversalEdges,
  isComposableEdge,
  isFunctionEdge,
} from '../src/paths.js';

/**
 * The issue's reproduction: entity `A` has a bound function `B` returning
 * entity `C`. The parser records `isBound`, the binding parameter and
 * `returnType`; this module must turn them into a traversable edge.
 */
const REPRO = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.01" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="A"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
      <EntityType Name="C"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
      <Function Name="B" IsBound="true">
        <Parameter Name="it" Type="N.A" />
        <ReturnType Type="N.C" />
      </Function>
      <EntityContainer Name="C1">
        <EntitySet Name="As" EntityType="N.A" />
        <EntitySet Name="Cs" EntityType="N.C" />
        <FunctionImport Name="B" Function="N.B" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

async function edgesOf(csdl: string) {
  const metadata = await parseCSDL(csdl);
  return { metadata, edges: getTraversalEdges(metadata) };
}

describe('operation edge derivation', () => {
  it('derives a bound-function edge from the reproduction metadata', async () => {
    const { edges } = await edgesOf(REPRO);
    const operations = edges.filter(isFunctionEdge);

    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      kind: 'boundFunction',
      functionName: 'B',
      qualifiedName: 'N.B',
      from: 'A',
      to: 'C',
      bindingIsCollection: false,
      returnsCollection: false,
    });
    expect(operations[0].parameters).toEqual([]);
  });

  it('does not derive an edge for an unbound function', async () => {
    const { edges } = await edgesOf(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.01" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="A"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
      <EntityType Name="C"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
      <Function Name="B"><ReturnType Type="N.C" /></Function>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);

    expect(edges.filter(isFunctionEdge)).toHaveLength(0);
  });

  it('ignores an unbound function even when a parameter is flagged as binding', () => {
    // Consumers can inject hand-built metadata (the MCP store does); the
    // `isBound` guard is what keeps a malformed definition from becoming an edge.
    const metadata: ODataMetadata = {
      entities: [
        {
          name: 'A',
          qualifiedName: 'N.A',
          namespace: 'N',
          properties: [],
          navigationProperties: [],
          keys: [],
        },
        {
          name: 'C',
          qualifiedName: 'N.C',
          namespace: 'N',
          properties: [],
          navigationProperties: [],
          keys: [],
        },
      ],
      relationships: [],
      entityContainers: [],
      functionImports: [],
      actionImports: [],
      actions: [],
      functions: [
        {
          name: 'B',
          qualifiedName: 'N.B',
          namespace: 'N',
          isBound: false,
          parameters: [{ name: 'it', type: 'N.A', isBinding: true }],
          returnType: 'N.C',
        },
      ],
      enumTypes: [],
      typeDefinitions: [],
    };

    expect(getTraversalEdges(metadata).filter(isFunctionEdge)).toHaveLength(0);
  });

  it('does not derive an edge for a primitive return type', async () => {
    const { edges } = await edgesOf(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.01" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="A"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
      <Function Name="Count" IsBound="true">
        <Parameter Name="it" Type="N.A" />
        <ReturnType Type="Edm.Int32" />
      </Function>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);

    expect(edges.filter(isFunctionEdge)).toHaveLength(0);
  });

  it('does not derive an edge when the return type resolves to no entity', async () => {
    const { metadata, edges } = await edgesOf(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.01" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="A"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
      <Function Name="B" IsBound="true">
        <Parameter Name="it" Type="N.A" />
        <ReturnType Type="N.Missing" />
      </Function>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);

    expect(metadata.functions[0].returnType).toBe('N.Missing');
    expect(edges.filter(isFunctionEdge)).toHaveLength(0);
  });

  it('does not derive an edge when the return type lives in an unloaded reference', async () => {
    const { metadata, edges } = await edgesOf(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.01" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="A"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
      <Function Name="B" IsBound="true">
        <Parameter Name="it" Type="N.A" />
        <ReturnType Type="Other.C" />
      </Function>
      <edmx:Reference Uri="https://example.org/other.xml">
        <edmx:Include Namespace="Other" />
      </edmx:Reference>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);

    expect(metadata.unresolvedReferences).toContain('https://example.org/other.xml');
    expect(edges.filter(isFunctionEdge)).toHaveLength(0);
  });

  it('does not derive an edge when the binding type resolves to no entity', async () => {
    const { edges } = await edgesOf(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.01" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="C"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
      <Function Name="B" IsBound="true">
        <Parameter Name="it" Type="N.Gone" />
        <ReturnType Type="N.C" />
      </Function>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);

    expect(edges.filter(isFunctionEdge)).toHaveLength(0);
  });

  it('unwraps Collection(...) on the binding parameter', async () => {
    const { edges } = await edgesOf(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.01" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="A"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
      <EntityType Name="C"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
      <Function Name="All" IsBound="true">
        <Parameter Name="it" Type="Collection(N.A)" />
        <ReturnType Type="Collection(N.C)" />
      </Function>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);
    const operation = edges.filter(isFunctionEdge)[0];

    expect(operation).toMatchObject({
      from: 'A',
      to: 'C',
      bindingIsCollection: true,
      returnsCollection: true,
    });
  });

  it('exposes the non-binding parameters a caller must supply', async () => {
    const { edges } = await edgesOf(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.01" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="A"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
      <EntityType Name="C"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
      <Function Name="B" IsBound="true">
        <Parameter Name="it" Type="N.A" />
        <Parameter Name="limit" Type="Edm.Int32" Nullable="false" />
        <ReturnType Type="N.C" />
      </Function>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);
    const operation = edges.filter(isFunctionEdge)[0];

    expect(operation.parameters.map((p) => p.name)).toEqual(['limit']);
    expect(isComposableEdge(operation)).toBe(false);
  });

  it('treats a parameter-free bound function as composable', async () => {
    const { edges } = await edgesOf(REPRO);
    const operation = edges.filter(isFunctionEdge)[0];
    expect(isComposableEdge(operation)).toBe(true);
  });

  it('keeps same-named functions in different namespaces apart', async () => {
    const { edges } = await edgesOf(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.01" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="One" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="A"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
      <EntityType Name="C"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
      <Function Name="B" IsBound="true">
        <Parameter Name="it" Type="One.A" />
        <ReturnType Type="One.C" />
      </Function>
    </Schema>
    <Schema Namespace="Two" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="A"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
      <EntityType Name="C"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
      <Function Name="B" IsBound="true">
        <Parameter Name="it" Type="Two.A" />
        <ReturnType Type="Two.C" />
      </Function>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);
    const operations = edges.filter(isFunctionEdge);

    expect(operations.map((e) => e.qualifiedName).sort()).toEqual(['One.B', 'Two.B']);
    expect(operations.find((e) => e.qualifiedName === 'One.B')).toMatchObject({
      from: 'One.A',
      to: 'One.C',
    });
    expect(operations.find((e) => e.qualifiedName === 'Two.B')).toMatchObject({
      from: 'Two.A',
      to: 'Two.C',
    });
  });

  it('keeps an unqualified binding type in its own namespace', async () => {
    const { edges } = await edgesOf(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.01" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Other" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="A"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
      <EntityType Name="C"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
    </Schema>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="A"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
      <EntityType Name="C"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
      <Function Name="B" IsBound="true">
        <Parameter Name="it" Type="A" />
        <ReturnType Type="C" />
      </Function>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);
    const operation = edges.filter(isFunctionEdge)[0];

    // `Other` is declared first; a global short-name lookup would land there.
    expect(operation).toMatchObject({ from: 'N.A', to: 'N.C' });
  });

  it('emits one edge per overload, distinguished by their parameters', async () => {
    const { edges } = await edgesOf(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.01" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="A"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
      <EntityType Name="C"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
      <Function Name="B" IsBound="true">
        <Parameter Name="it" Type="N.A" />
        <ReturnType Type="N.C" />
      </Function>
      <Function Name="B" IsBound="true">
        <Parameter Name="it" Type="N.A" />
        <Parameter Name="factor" Type="Edm.Int32" />
        <ReturnType Type="N.C" />
      </Function>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);
    const operations = edges.filter(isFunctionEdge);

    expect(operations).toHaveLength(2);
    expect(operations.map((e) => e.parameters.length).sort()).toEqual([0, 1]);
    expect(operations.filter((e) => e.parameters.length === 0)).toHaveLength(1);
  });
});

/**
 * OData V4.01 Part 1 §11.5.1: a function bound to `Base` is invocable on
 * `Derived` instances. Bound-function edges must therefore be derived per
 * entity, exactly as inherited navigation properties are, so both the
 * pathfinder and MCP can discover the step from every inheriting type.
 */
describe('bound functions on a base type', () => {
  /** The issue's fixture, verbatim. */
  const INHERITED = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.01" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Base" />
      <EntityType Name="Derived" BaseType="N.Base" />
      <EntityType Name="C" />
      <Function Name="B" IsBound="true">
        <Parameter Name="it" Type="N.Base" />
        <ReturnType Type="N.C" />
      </Function>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

  /**
   * A malformed-but-parseable document: the parser keeps both `Base`
   * declarations, and both share the identity `N.Base`. Without the dedup
   * guard the function would emit `N.Base -> C` once per declaration.
   */
  const DUPLICATE_DECLARATION = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.01" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Base" />
      <EntityType Name="Base" />
      <EntityType Name="Derived" BaseType="N.Base" />
      <EntityType Name="C" />
      <Function Name="B" IsBound="true">
        <Parameter Name="it" Type="N.Base" />
        <ReturnType Type="N.C" />
      </Function>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

  it('derives exactly one edge from the binding type and each derived type', async () => {
    const { edges } = await edgesOf(INHERITED);
    const operations = edges.filter(isFunctionEdge);

    expect(operations).toHaveLength(2);
    // Entity document order: `Base` is declared before `Derived`, so its edge
    // comes first. Not sorted — the order is promised and must stay pinned.
    expect(operations.map((e) => e.from)).toEqual(['Base', 'Derived']);
    expect(operations.map((e) => e.to)).toEqual(['C', 'C']);
    expect(operations.every((e) => e.functionName === 'B')).toBe(true);
  });

  it('finds the function step from the derived type', async () => {
    const metadata = await parseCSDL(INHERITED);
    const paths = findPaths('Derived', 'C', metadata);

    expect(paths).toHaveLength(1);
    expect(paths[0]).toHaveLength(1);
    expect(paths[0][0].edge).toMatchObject({
      kind: 'boundFunction',
      functionName: 'B',
      from: 'Derived',
      to: 'C',
    });
    // The binding type keeps its own edge.
    expect(findPaths('Base', 'C', metadata)).toHaveLength(1);
  });

  it('reports the derived type reaching C', async () => {
    const metadata = await parseCSDL(INHERITED);
    const reachable = getReachableEntities('Derived', metadata);
    const targets = [...reachable.values()].flat().map((step) => step.to);

    expect(targets).toContain('C');
    expect(reachable.get('Derived')?.map((s) => s.edge.kind)).toEqual(['boundFunction']);
  });

  it('walks a multi-level inheritance chain', async () => {
    const { metadata, edges } = await edgesOf(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.01" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Base" />
      <EntityType Name="Mid" BaseType="N.Base" />
      <EntityType Name="Derived" BaseType="N.Mid" />
      <EntityType Name="C" />
      <Function Name="B" IsBound="true">
        <Parameter Name="it" Type="N.Base" />
        <ReturnType Type="N.C" />
      </Function>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);
    const operations = edges.filter(isFunctionEdge);

    // Declaration order, not inheritance distance: `Base` then `Mid` then
    // `Derived`, each one step deeper.
    expect(operations.map((e) => e.from)).toEqual(['Base', 'Mid', 'Derived']);
    expect(findPaths('Derived', 'C', metadata)).toHaveLength(1);
  });

  it('emits one edge per identity when a type is declared twice', async () => {
    // #70.1: the dedup guard in the inheritor index. Both `Base` entries carry
    // the identity `N.Base`, so without `!sources.includes(from)` the function's
    // edge from that identity is emitted twice.
    const { metadata, edges } = await edgesOf(DUPLICATE_DECLARATION);
    const operations = edges.filter(isFunctionEdge);

    expect(metadata.entities.filter((e) => e.name === 'Base')).toHaveLength(2);
    expect(operations.map((e) => e.from)).toEqual(['N.Base', 'Derived']);
    expect(operations.map((e) => e.to)).toEqual(['C', 'C']);
    expect(findPaths('N.Base', 'C', metadata)).toHaveLength(1);
  });

  it('does not walk an edge from a type that only inherits from the binding type', async () => {
    // Bound to Mid, so Base must not gain an edge: a base type is not
    // substitutable for its derived binding type.
    const { metadata, edges } = await edgesOf(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.01" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Base" />
      <EntityType Name="Mid" BaseType="N.Base" />
      <EntityType Name="Derived" BaseType="N.Mid" />
      <EntityType Name="C" />
      <Function Name="B" IsBound="true">
        <Parameter Name="it" Type="N.Mid" />
        <ReturnType Type="N.C" />
      </Function>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);
    const operations = edges.filter(isFunctionEdge);

    // The binding type first (declared before its inheritors), then the
    // inheriting type.
    expect(operations.map((e) => e.from)).toEqual(['Mid', 'Derived']);
    expect(findPaths('Base', 'C', metadata)).toEqual([]);
  });
});

/**
 * #70.3: a function bound to a base type and returning one of its inheritors
 * gives the returned type a self-loop (`Derived -> Derived`) beside the base's
 * edge. `getReachableEntities` keys its visited set by edge, so `Derived` is
 * enqueued again through the self-loop and the step is listed once per visit.
 * The duplication predates #68 — a pure navigation self-loop does the same on
 * unmodified code — and consumers that need distinct steps deduplicate
 * (PathFinder does, through a `Set`). The fan-in shape below is the same
 * mechanism without a self-loop.
 */
describe('a base-bound function returning a derived type', () => {
  const SELF_LOOP = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.01" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Base" />
      <EntityType Name="Derived" BaseType="N.Base" />
      <Function Name="T" IsBound="true">
        <Parameter Name="it" Type="N.Base" />
        <ReturnType Type="N.Derived" />
      </Function>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

  it('lists the self-loop step once per visit', async () => {
    const metadata = await parseCSDL(SELF_LOOP);
    const steps = getReachableEntities('Derived', metadata).get('Derived') ?? [];

    expect(steps.map((s) => s.to)).toEqual(['Derived', 'Derived']);
    expect(steps.every((s) => isFunctionEdge(s.edge) && s.edge.functionName === 'T')).toBe(true);
    // The base type still reaches the derived type through the same function.
    expect(
      getReachableEntities('Base', metadata)
        .get('Base')
        ?.map((s) => s.to),
    ).toEqual(['Derived']);
  });
});

/**
 * Fan-in is the general shape the edge-keyed visited set duplicates: `Hub` is
 * reached through two different edges and enqueued once per inbound edge, so
 * each visit re-lists its outbound step. No self-loop is involved.
 */
describe('fan-in under getReachableEntities', () => {
  const DIAMOND = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.01" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Root"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="ToP0" Type="N.P0" />
        <NavigationProperty Name="ToP1" Type="N.P1" /></EntityType>
      <EntityType Name="P0"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="ToHub" Type="N.Hub" /></EntityType>
      <EntityType Name="P1"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="ToHub" Type="N.Hub" /></EntityType>
      <EntityType Name="Hub"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="ToSink" Type="N.Sink" /></EntityType>
      <EntityType Name="Sink"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

  it('lists the fan-in node’s outbound step once per inbound edge', async () => {
    const metadata = await parseCSDL(DIAMOND);
    const reachable = getReachableEntities('Root', metadata);

    expect(reachable.get('Root')?.map((step) => step.to)).toEqual(['P0', 'P1']);
    expect(reachable.get('P0')?.map((step) => step.to)).toEqual(['Hub']);
    expect(reachable.get('P1')?.map((step) => step.to)).toEqual(['Hub']);
    // Two enqueues, two visits, two emissions of the same step.
    expect(reachable.get('Hub')?.map((step) => step.to)).toEqual(['Sink', 'Sink']);
  });
});

describe('nav edges and traversal', () => {
  const mixed = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.01" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="A"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="X" Type="N.X" />
      </EntityType>
      <EntityType Name="X"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="Ys" Type="Collection(N.Y)" />
      </EntityType>
      <EntityType Name="Y"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
      <EntityType Name="C"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
      <Function Name="FromX" IsBound="true">
        <Parameter Name="it" Type="N.X" />
        <ReturnType Type="N.C" />
      </Function>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

  it('derives nav edges beside function edges', async () => {
    const { edges } = await edgesOf(mixed);
    const navs = edges.filter((e) => e.kind === 'nav');

    expect(navs.map((e) => e.name).sort()).toEqual(['X', 'Ys']);
    expect(navs.find((e) => e.name === 'X')).toMatchObject({ from: 'A', to: 'X' });
    expect(navs.find((e) => e.name === 'Ys')).toMatchObject({ from: 'X', to: 'Y' });
    // Navigation edges are always composable; they carry no parameters.
    expect(navs.every(isComposableEdge)).toBe(true);
  });

  it('keeps a V3 nav edge when an unrelated reference is unfetched', async () => {
    // The upload path parses with no loader, so this reference is recorded
    // unresolved; it included `Other`, not `Ghost`, so the stray qualifier the
    // navigation property carries still resolves through its namesake.
    const metadata = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <edmx:Reference Uri="shared.xml"><edmx:Include Namespace="Other" /></edmx:Reference>
      <EntityType Name="Customer">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="Orders" Relationship="Ghost.R1" FromRole="Customer" ToRole="Order" />
      </EntityType>
      <EntityType Name="Order">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <Association Name="R1">
        <End Type="N.Customer" Role="Customer" Multiplicity="1" />
        <End Type="N.Order" Role="Order" Multiplicity="*" />
      </Association>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);

    expect(metadata.unresolvedReferences).toContain('shared.xml');
    expect(
      getTraversalEdges(metadata)
        .filter((edge) => edge.kind === 'nav')
        .map((edge) => `${edge.from}->${edge.to}[${edge.name}]`),
    ).toEqual(['Customer->Order[Orders]']);
    expect(findPaths('Customer', 'Order', metadata)).toHaveLength(1);
  });

  it('finds a mixed nav + function path A -> X -> C', async () => {
    const metadata = await parseCSDL(mixed);
    const paths = findPaths('A', 'C', metadata);

    expect(paths).toHaveLength(1);
    expect(paths[0].map((s) => s.edge.kind)).toEqual(['nav', 'boundFunction']);
    expect(paths[0][0]).toMatchObject({ from: 'A', to: 'X' });
    expect(paths[0][1]).toMatchObject({ from: 'X', to: 'C' });
  });

  it('returns nav-only and function paths together when both reach the target', async () => {
    const metadata = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.01" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="A"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="Direct" Type="N.C" />
      </EntityType>
      <EntityType Name="C"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
      <Function Name="B" IsBound="true">
        <Parameter Name="it" Type="N.A" />
        <ReturnType Type="N.C" />
      </Function>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);
    const paths = findPaths('A', 'C', metadata);

    expect(paths).toHaveLength(2);
    expect(paths.map((p) => p[0].edge.kind).sort()).toEqual(['boundFunction', 'nav']);
  });

  it('reaches C from A through the bound function', async () => {
    const metadata = await parseCSDL(REPRO);
    const reachable = getReachableEntities('A', metadata);
    const targets = [...reachable.values()].flat().map((step) => step.to);

    expect(targets).toContain('C');
    expect(reachable.get('A')?.map((s) => s.edge.kind)).toEqual(['boundFunction']);
  });

  it('lists successor edges for one entity', async () => {
    const metadata = await parseCSDL(REPRO);
    const successors = getSuccessorEdges('A', metadata);

    expect(successors).toHaveLength(1);
    expect(successors[0]).toMatchObject({ kind: 'boundFunction', functionName: 'B', to: 'C' });
  });

  it('does not loop on a function whose return type equals its binding type', async () => {
    const metadata = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.01" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="A"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
      <EntityType Name="C"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
      <Function Name="Again" IsBound="true">
        <Parameter Name="it" Type="N.A" />
        <ReturnType Type="N.A" />
      </Function>
      <Function Name="ToC" IsBound="true">
        <Parameter Name="it" Type="N.A" />
        <ReturnType Type="N.C" />
      </Function>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);

    // The self-returning function must terminate and must not hide the edge to C.
    const paths = findPaths('A', 'C', metadata);
    expect(paths).toHaveLength(1);
    expect(paths[0][0].edge).toMatchObject({ functionName: 'ToC', to: 'C' });

    const reachable = getReachableEntities('A', metadata);
    expect([...reachable.values()].flat().map((s) => s.to)).toContain('C');
  });

  it('does not re-enter an entity already on the path', async () => {
    const metadata = await parseCSDL(REPRO);
    expect(findPaths('A', 'A', metadata)).toEqual([]);
  });
});

describe('alias-qualified function types', () => {
  it('resolves an alias-qualified type declared by the function document', async () => {
    const metadata = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.01" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" Alias="Self" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="A"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
      <EntityType Name="C"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
      <Function Name="B" IsBound="true">
        <Parameter Name="it" Type="Self.A" />
        <ReturnType Type="Self.C" />
      </Function>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);
    const operation = getTraversalEdges(metadata).filter(isFunctionEdge)[0];

    expect(metadata.functions[0].parameters[0].type).toBe('N.A');
    expect(operation).toMatchObject({ from: 'A', to: 'C' });
  });

  it('does not resolve an alias declared by a different document', async () => {
    const external = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="M" Alias="Self" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="A"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
      <EntityType Name="C"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

    const metadata = await parseCSDL(
      `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.01" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:Reference Uri="https://example.org/ext.xml">
    <edmx:Include Namespace="M" />
  </edmx:Reference>
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="A"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
      <EntityType Name="C"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
      <Function Name="B" IsBound="true">
        <Parameter Name="it" Type="Self.A" />
        <ReturnType Type="Self.C" />
      </Function>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`,
      { loadExternal: async () => external },
    );

    // `Self` belongs to M's document, so N's function cannot use it; the edge
    // must not silently bind to M.A/M.C.
    expect(metadata.functions[0].parameters[0].type).toBe('Self.A');
    expect(getTraversalEdges(metadata).filter(isFunctionEdge)).toHaveLength(0);
  });
});

/**
 * An unqualified type reference means the enclosing namespace. `findTypeInScope`
 * falls back to any short-name match when the scope hint finds nothing, so a
 * reference that cannot resolve in its own namespace used to bind to a
 * *stranger's* type of the same name — producing an edge between two types the
 * function never mentioned, and breaking the "unresolved types never create
 * edges" criterion.
 */
describe('an unqualified reference stays in its own namespace', () => {
  it('does not bind to another namespace type of the same name', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Other" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="A">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <EntityType Name="C">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
    </Schema>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <Function Name="B" IsBound="true">
        <Parameter Name="it" Type="A" />
        <ReturnType Type="C" />
      </Function>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);

    // `A` and `C` are unqualified and `N` declares neither, so this function
    // names nothing resolvable and must yield no edge at all.
    expect(getTraversalEdges(model).filter(isFunctionEdge)).toHaveLength(0);
  });
});

/**
 * A cycle *away from the source*. The DFS seeds `visited` with the source, so an
 * `A → A` self-loop is cut by that seed alone — which is why the mutation table's
 * "remove the cycle guard" row did not reproduce. This fixture puts the loop on
 * an intermediate node, where the guard is the only thing that stops it.
 */
describe('a cycle at a non-source node', () => {
  it('yields exactly one path', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="A">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="ToB" Type="N.B" />
      </EntityType>
      <EntityType Name="B">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="LoopB" Type="N.B" />
        <NavigationProperty Name="ToC" Type="N.C" />
      </EntityType>
      <EntityType Name="C">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);

    expect(findPaths('A', 'C', model)).toHaveLength(1);
  });
});
