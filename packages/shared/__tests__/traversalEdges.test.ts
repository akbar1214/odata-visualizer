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
 * OData V4 §11.2.2: a function bound to `Base` is invocable on `Derived`
 * instances. Bound-function edges must therefore be derived per entity, exactly
 * as inherited navigation properties are, so both the pathfinder and MCP can
 * discover the step from every inheriting type.
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

  it('derives exactly one edge from the binding type and each derived type', async () => {
    const { edges } = await edgesOf(INHERITED);
    const operations = edges.filter(isFunctionEdge);

    expect(operations).toHaveLength(2);
    expect(operations.map((e) => e.from).sort()).toEqual(['Base', 'Derived']);
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

    expect(operations.map((e) => e.from).sort()).toEqual(['Base', 'Derived', 'Mid']);
    expect(findPaths('Derived', 'C', metadata)).toHaveLength(1);
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

    expect(operations.map((e) => e.from).sort()).toEqual(['Derived', 'Mid']);
    expect(findPaths('Base', 'C', metadata)).toEqual([]);
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
