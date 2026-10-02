import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { parseCSDL } from '@odata-visualizer/shared';
import { QueryBuilder } from '../src/components/QueryBuilder';

const csdl = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Shop" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <ComplexType Name="Money">
        <Property Name="Amount" Type="Edm.Decimal" />
      </ComplexType>
      <EntityType Name="Order">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <EntityType Name="OrderLine">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <EntityType Name="Loose">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Orders" EntityType="Shop.Order" />
        <EntitySet Name="Lines" EntityType="Shop.OrderLine" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

async function renderBuilder() {
  const metadata = await parseCSDL(csdl);
  render(
    <ReactFlowProvider>
      <QueryBuilder metadata={metadata} />
    </ReactFlowProvider>,
  );
  return metadata;
}

/** The preview is the <pre> block that holds the generated query. */
function preview(): HTMLElement {
  return document.querySelector('pre') as HTMLElement;
}

/**
 * QueryBuilder renders the entity selector first, then PathFinder's two
 * selectors, so the entity one is the first combobox. The listbox only exists
 * once the input is focused.
 */
function entityInput(): HTMLElement {
  return screen.getAllByRole('combobox')[0];
}

function entityListbox(): HTMLElement {
  return screen.getAllByRole('listbox')[0];
}

function chooseEntity(label: string) {
  fireEvent.focus(entityInput());
  fireEvent.mouseDown(within(entityListbox()).getByText(label));
}

describe('QueryBuilder entity selector wiring', () => {
  afterEach(() => cleanup());

  it('starts on an entity set path, not a type path', async () => {
    await renderBuilder();
    expect(preview().textContent).toBe('/Orders?$top=25');
  });

  it('does not offer complex types, which have no resource path', async () => {
    await renderBuilder();

    fireEvent.focus(entityInput());

    const options = within(entityListbox())
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options.some((text) => text?.includes('Money'))).toBe(false);
    // Entity types are still offered.
    expect(options.some((text) => text?.includes('OrderLine'))).toBe(true);
  });

  it('explains an entity that has no entity set instead of saying "select an entity"', async () => {
    await renderBuilder();

    // `Loose` is a concrete entity with no set: previously this emitted
    // `/Loose`, which cannot be resolved.
    chooseEntity('Loose');

    expect(preview().textContent).toContain('not exposed as an entity set');
    expect(preview().textContent).not.toContain('Select an entity');
  });

  it('keeps the encoding warning instead of blaming an entity set that is exposed', async () => {
    // `parseCSDL` preserves a lone surrogate, so a crafted upload reaches the
    // preview: `Orders` exists but no URL can carry its name. The empty state
    // must not contradict the warning that already says why there is no query.
    const metadata = await parseCSDL(csdl);
    const orders = metadata.entityContainers[0].entitySets.find((set) => set.name === 'Orders')!;
    orders.name = 'Or\uD800ders';

    render(
      <ReactFlowProvider>
        <QueryBuilder metadata={metadata} />
      </ReactFlowProvider>,
    );

    expect(preview().textContent).not.toContain('not exposed as an entity set');
    expect(within(screen.getByRole('list')).getByText(/could not be encoded/)).toBeDefined();
  });

  it('shows the built path again once an addressable entity is chosen', async () => {
    await renderBuilder();

    chooseEntity('Loose');
    expect(preview().textContent).toContain('not exposed as an entity set');

    chooseEntity('OrderLine');
    expect(preview().textContent).toBe('/Lines?$top=25');
  });
});
