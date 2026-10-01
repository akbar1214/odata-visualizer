import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { parseCSDL } from '@odata-visualizer/shared';
import { QueryCanvas } from '../src/components/query/QueryCanvas';
import { PathFinder } from '../src/components/query/PathFinder';
import { QueryBuilder } from '../src/components/QueryBuilder';
import { createRootNode, type GraphNodeState, type GraphEdge } from '../src/utils/graphState';

/**
 * Two namespaces declare the same type names. Every value that leaves the query
 * UI — node entity names, dropdown values, path steps — has to be an identity
 * that names one type, not the shared short name.
 */
const ambiguousCsdl = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="A" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="Docs" Type="Collection(B.Part)" />
      </EntityType>
      <EntityType Name="Part">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="AOnly" Type="Edm.String" />
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="Owners" Type="Collection(A.Widget)" />
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

describe('QueryCanvas filter add on a qualified node', () => {
  afterEach(() => cleanup());

  it('adds a filter from the properties of the node’s own namespace', async () => {
    const metadata = await ambiguousModel();
    const node: GraphNodeState = { ...createRootNode('B.Part') };
    const onGraphChange = vi.fn<(nodes: GraphNodeState[], edges: GraphEdge[]) => void>();

    render(
      <QueryCanvas
        graphNodes={[node]}
        graphEdges={[]}
        metadata={metadata}
        onGraphChange={onGraphChange}
      />,
    );

    fireEvent.click(screen.getByText('$filter'));
    fireEvent.click(screen.getByText('+ add filter'));

    expect(onGraphChange).toHaveBeenCalled();
    const [nodes] = onGraphChange.mock.calls[0];
    // `BOnly` is B.Part's first property. A first-match on the short name
    // (`A.Part`, declared first) would offer `AOnly`, and a lookup by
    // `e.name === 'B.Part'` matches nothing at all.
    expect(nodes[0].filters).toEqual([{ property: 'BOnly', operator: 'eq', value: '' }]);
  });
});

describe('PathFinder across colliding short names', () => {
  afterEach(() => cleanup());

  it('offers the target by identity and finds the path to it', async () => {
    const metadata = await ambiguousModel();
    const onSelectPath = vi.fn();

    render(<PathFinder metadata={metadata} currentEntity="A.Widget" onSelectPath={onSelectPath} />);

    // The "To entity" control is the second combobox.
    const toInput = screen.getAllByRole('combobox')[1];
    fireEvent.focus(toInput);
    fireEvent.mouseDown(screen.getByRole('option', { name: 'B.Part' }));

    fireEvent.click(screen.getByText('Find Paths'));
    expect(screen.getByText('1 path(s) found')).toBeTruthy();

    fireEvent.click(screen.getByText('Path 1 (1 hop)'));
    expect(onSelectPath).toHaveBeenCalledWith('A.Widget', [
      {
        from: 'A.Widget',
        to: 'B.Part',
        edge: {
          kind: 'nav',
          name: 'Docs',
          from: 'A.Widget',
          to: 'B.Part',
          targetType: 'B.Part',
        },
      },
    ]);
  });
});

/**
 * The entity selector only offers queryable types, but identity must be
 * computed against the whole model: `B.Part` is abstract here, so it is not
 * offered, yet it still makes `A.Part`'s short name ambiguous. Against the
 * filtered list alone the sole `Part` is emitted as `Part`, which resolves to
 * the abstract type and loses the resource path.
 */
const abstractCollisionCsdl = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="B" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Part" Abstract="true">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
    </Schema>
    <Schema Namespace="A" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Part">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Products" EntityType="A.Part" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

describe('QueryBuilder identity against the whole model', () => {
  afterEach(() => cleanup());

  function preview(): HTMLElement {
    return document.querySelector('pre') as HTMLElement;
  }

  it('queries the concrete type when an abstract namesake is not offered', async () => {
    const metadata = await parseCSDL(abstractCollisionCsdl);

    render(<QueryBuilder metadata={metadata} />);

    // Initial selection: `Part` would resolve to the abstract B.Part, which has
    // no set, and the preview would report it as unaddressable.
    expect(preview().textContent).toBe('/Products?$top=25');
  });

  it('keeps the identity when the entity is re-selected from the filtered list', async () => {
    const metadata = await parseCSDL(abstractCollisionCsdl);
    render(<QueryBuilder metadata={metadata} />);

    const entityInput = screen.getAllByRole('combobox')[0];
    fireEvent.focus(entityInput);
    fireEvent.mouseDown(screen.getByRole('option', { name: 'A.Part' }));

    expect(preview().textContent).toBe('/Products?$top=25');
  });
});
