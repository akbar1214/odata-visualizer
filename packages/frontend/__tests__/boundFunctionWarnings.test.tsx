import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { parseCSDL } from '@odata-visualizer/shared';
import { QueryBuilder } from '../src/components/QueryBuilder';
import { PathFinder } from '../src/components/query/PathFinder';

/**
 * A composable bound function and a parameterised one from the same source:
 * the PathFinder must offer a target that is reachable only through the
 * parameterised function (otherwise its "path(s) hidden" note can never fire),
 * and the builder must say when a function path drops the root card's options.
 */
const csdl = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.01" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="A"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
      <EntityType Name="C"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
      <EntityType Name="D"><Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
      <Function Name="B" IsBound="true">
        <Parameter Name="it" Type="N.A" />
        <ReturnType Type="N.C" />
      </Function>
      <Function Name="WithParam" IsBound="true">
        <Parameter Name="it" Type="N.A" />
        <Parameter Name="limit" Type="Edm.Int32" />
        <ReturnType Type="N.D" />
      </Function>
      <EntityContainer Name="C1">
        <EntitySet Name="As" EntityType="N.A" />
        <EntitySet Name="Cs" EntityType="N.C" />
        <EntitySet Name="Ds" EntityType="N.D" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

/** The preview is the <pre> block that holds the generated query. */
function preview(): HTMLElement {
  return document.querySelector('pre') as HTMLElement;
}

/** The visible warning list. */
function warningList(): HTMLElement {
  return screen.getByRole('list');
}

describe('PathFinder target list', () => {
  afterEach(() => cleanup());

  it('offers a target reachable only through a parameterised function', async () => {
    const metadata = await parseCSDL(csdl);
    render(<PathFinder metadata={metadata} currentEntity="A" onSelectPath={() => undefined} />);

    // The target dropdown used to filter out every non-composable edge, so D
    // was absent and the hidden-path note below could never explain why.
    const targetInput = screen.getAllByRole('combobox')[1];
    fireEvent.focus(targetInput);
    fireEvent.mouseDown(within(screen.getByRole('listbox')).getByText('D'));

    fireEvent.click(screen.getByRole('button', { name: 'Find Paths' }));

    expect(screen.getByText('1 path(s) found')).toBeDefined();
    expect(screen.getByText(/1 path\(s\) hidden/)).toBeDefined();
    // Nothing on this path is composable, so no path button is offered.
    expect(screen.queryByText(/^Path 1/)).toBeNull();
  });
});

describe('QueryBuilder root-option warning', () => {
  afterEach(() => cleanup());

  it('explains root options that a function path cannot carry', async () => {
    const metadata = await parseCSDL(csdl);
    render(
      <ReactFlowProvider>
        <QueryBuilder metadata={metadata} />
      </ReactFlowProvider>,
    );

    // Entity selector, source and target: the target is the third combobox.
    const targetInput = screen.getAllByRole('combobox')[2];
    fireEvent.focus(targetInput);
    fireEvent.mouseDown(within(screen.getByRole('listbox')).getByText('C'));
    fireEvent.click(screen.getByRole('button', { name: 'Find Paths' }));
    fireEvent.click(screen.getByText(/^Path 1/));

    // The graph is root A -> B() -> C; the query addresses the result, whose
    // card owns the options.
    await waitFor(() => expect(preview().textContent).toBe("/As('1')/N.B()"));

    // Change the root card's $top: it is editable, so leaving it out of the
    // preview without a word is the defect.
    const rootTop = screen
      .getAllByPlaceholderText('0')
      .find((input) => (input as HTMLInputElement).value === '25') as HTMLInputElement;
    fireEvent.change(rootTop, { target: { value: '7' } });

    expect(preview().textContent).toBe("/As('1')/N.B()");
    expect(
      within(warningList()).getByText(/root card's options are not part of the query/),
    ).toBeDefined();
  });
});
