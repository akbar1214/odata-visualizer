import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { ODataEntity, ODataMetadata } from '@odata-visualizer/shared';
import { parseCSDL } from '@odata-visualizer/shared';
import { MetadataExplorer } from '../src/components/MetadataExplorer';

function makeEntity(index: number): ODataEntity {
  return {
    name: `Type${index}`,
    namespace: 'Big',
    kind: 'entity',
    abstract: false,
    openType: false,
    properties: [],
    navigationProperties: [],
    keys: ['Id'],
  };
}

function makeMetadata(count: number): ODataMetadata {
  return {
    entities: Array.from({ length: count }, (_, i) => makeEntity(i)),
    relationships: [],
    entityContainers: [],
    functionImports: [],
    actionImports: [],
    actions: [],
    functions: [],
    enumTypes: [],
    typeDefinitions: [],
  };
}

async function modelWithComplex(count: number): Promise<ODataMetadata> {
  const entities = Array.from({ length: count }, (_, i) => makeEntity(i));
  entities.push({
    name: 'Money',
    namespace: 'Big',
    kind: 'complex',
    abstract: false,
    openType: false,
    properties: [],
    navigationProperties: [],
    keys: [],
  });
  return { ...makeMetadata(0), entities };
}

describe('MetadataExplorer search', () => {
  afterEach(() => cleanup());

  it('warns when results are truncated with no search term', async () => {
    render(<MetadataExplorer metadata={makeMetadata(250)} />);
    // Previously the list was silently capped at 200 with no explanation.
    await waitFor(() => {
      expect(screen.getByText(/Showing the first 200 of 250 types/i)).toBeDefined();
    });
  });

  it('does not warn when everything fits', async () => {
    render(<MetadataExplorer metadata={makeMetadata(5)} />);
    await waitFor(() => {
      expect(screen.getAllByText('Type0').length).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/Showing the first/i)).toBeNull();
  });

  it('adjusts the denominator when a kind filter is active', async () => {
    const metadata = await modelWithComplex(3);
    render(<MetadataExplorer metadata={metadata} />);

    fireEvent.change(screen.getByLabelText('Search metadata'), {
      target: { value: 'Type' },
    });
    await waitFor(() => {
      expect(screen.getByText('3 of 4 types')).toBeDefined();
    });

    fireEvent.click(screen.getByText('Complex'));
    await waitFor(() => {
      // The denominator is the size of the complex-type scope, not all types.
      // "Type" matches no complex type, hence 0 of 1.
      expect(screen.getByText('0 of 1 type')).toBeDefined();
    });

    fireEvent.click(screen.getByLabelText('Clear search'));
    await waitFor(() => {
      expect(screen.getByText('1 of 1 type')).toBeDefined();
    });
  });

  it('searches relationships from the relationships tab', async () => {
    const metadata = await parseCSDL(`<?xml version="1.0"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices><Schema Namespace="S" xmlns="http://docs.oasis-open.org/odata/ns/edm">
    <EntityType Name="Order"><Key><PropertyRef Name="Id"/></Key><Property Name="Id" Type="Edm.String"/>
      <NavigationProperty Name="Lines" Type="Collection(S.OrderLine)"/></EntityType>
    <EntityType Name="OrderLine"><Key><PropertyRef Name="Id"/></Key><Property Name="Id" Type="Edm.String"/></EntityType>
  </Schema></edmx:DataServices></edmx:Edmx>`);

    render(<MetadataExplorer metadata={metadata} />);
    fireEvent.click(screen.getByText('Relationships'));
    await waitFor(() => expect(screen.getByText('Order_Lines')).toBeDefined());

    fireEvent.change(screen.getByLabelText('Search metadata'), {
      target: { value: 'zzz' },
    });
    await waitFor(() => {
      expect(screen.getByText(/No relationships match "zzz"/i)).toBeDefined();
    });
  });

  it('clears the search with the clear button', async () => {
    render(<MetadataExplorer metadata={makeMetadata(3)} />);
    const input = screen.getByLabelText('Search metadata') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Type1' } });
    await waitFor(() => expect(input.value).toBe('Type1'));

    fireEvent.click(screen.getByLabelText('Clear search'));
    await waitFor(() => expect(input.value).toBe(''));
  });
});
