import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { ODataEntity, ODataMetadata } from '@odata-visualizer/shared';
import { MetadataExplorer } from '../src/components/MetadataExplorer';

function makeEntity(index: number, namespace = 'Shop'): ODataEntity {
  return {
    name: `Type${index}`,
    qualifiedName: `${namespace}.Type${index}`,
    namespace,
    kind: 'entity',
    abstract: false,
    openType: false,
    properties: [],
    navigationProperties: [],
    keys: ['Id'],
  };
}

function makeMetadata(count: number, namespaces: string[] = ['Shop']): ODataMetadata {
  return {
    entities: Array.from({ length: count }, (_, i) =>
      makeEntity(i, namespaces[i % namespaces.length]),
    ),
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

describe('MetadataExplorer chrome', () => {
  afterEach(() => cleanup());

  it('offers the kind filter even with no search term', async () => {
    render(<MetadataExplorer metadata={makeMetadata(3)} />);
    // The chips used to appear only once you typed something.
    const complexChip = screen.getByRole('button', { name: 'Complex' });
    expect(complexChip).toBeDefined();
    // "All" is the pressed default; the tab of the same name is separate.
    expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('does not show result counts or chips on the stats tab', async () => {
    render(<MetadataExplorer metadata={makeMetadata(3)} />);
    fireEvent.click(screen.getByText('Stats'));

    await waitFor(() => expect(screen.getByText('Namespaces')).toBeDefined());
    expect(screen.queryByText(/\d+ of \d+ types/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Complex' })).toBeNull();
  });

  it('expands the card matching a diagram selection', async () => {
    const metadata = makeMetadata(3, ['A', 'B', 'C']);
    render(<MetadataExplorer metadata={metadata} selectedEntity="Type1" />);

    // selectedEntity carries a short name while cards are keyed by qualified
    // name, so the effect has to resolve the matching card before expanding.
    await waitFor(() => {
      expect(screen.getByText('Primary Keys')).toBeDefined();
    });
  });
});
