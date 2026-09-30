import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { parseCSDL } from '@odata-visualizer/shared';
import { buildODataQuery, getDefaultQuery } from '../src/utils/queryResolver';
import { QueryPreview } from '../src/components/query/QueryPreview';
import { QueryBuilder } from '../src/components/QueryBuilder';

/**
 * `buildODataQuery` leaves filter rows out when their value cannot be typed as
 * a literal for the property. #23 tightened integer validation, so complete
 * but invalid values (`2147483648` on Edm.Int32) are now dropped too — and
 * were dropped with no trace, leaving a preview that looked correct.
 *
 * The fix keeps the row out (the preview must stay buildable while editing)
 * but reports *why*, naming the property and the formatter's reason.
 */
const csdl = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Inv" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Item">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.Int32" Nullable="false" />
        <Property Name="Qty" Type="Edm.Byte" />
        <Property Name="Price" Type="Edm.Decimal" />
        <Property Name="Sku" Type="Edm.String" />
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Items" EntityType="Inv.Item" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

async function model() {
  return parseCSDL(csdl);
}

/** Collects every reason `buildODataQuery` reports while building. */
function warningSink() {
  const warnings: string[] = [];
  return { warnings, onWarning: (message: string) => warnings.push(message) };
}

describe('buildODataQuery reports why a filter row was left out', () => {
  it('names the property and the range when an Int32 value is out of range', async () => {
    const { warnings, onWarning } = warningSink();
    const url = buildODataQuery(
      {
        ...getDefaultQuery('Item'),
        filters: [{ property: 'Id', operator: 'eq', value: '2147483648' }],
        top: 5,
      },
      await model(),
      onWarning,
    );

    // The row stays out — a half-broken query must not replace the preview...
    expect(url).toBe('/Items?$top=5');
    // ...but it must not vanish silently either.
    expect(warnings).toEqual([
      'Filter on "Id" was left out of the query: Invalid Edm.Int32 value: 2147483648 (out of range -2147483648..2147483647)',
    ]);
  });

  it('names the property and the range when a Byte value is out of range', async () => {
    const { warnings, onWarning } = warningSink();
    const url = buildODataQuery(
      {
        ...getDefaultQuery('Item'),
        filters: [{ property: 'Qty', operator: 'eq', value: '999' }],
        top: 5,
      },
      await model(),
      onWarning,
    );

    expect(url).toBe('/Items?$top=5');
    expect(warnings).toEqual([
      'Filter on "Qty" was left out of the query: Invalid Edm.Byte value: 999 (out of range 0..255)',
    ]);
  });

  it('names the property when an integer value has a fraction', async () => {
    const { warnings, onWarning } = warningSink();
    const url = buildODataQuery(
      {
        ...getDefaultQuery('Item'),
        filters: [{ property: 'Id', operator: 'eq', value: '1.5' }],
        top: 5,
      },
      await model(),
      onWarning,
    );

    expect(url).toBe('/Items?$top=5');
    expect(warnings).toEqual([
      'Filter on "Id" was left out of the query: Invalid Edm.Int32 value: 1.5 (expected an integer)',
    ]);
  });

  it('stays silent about an empty row and keeps the rest of the query', async () => {
    const { warnings, onWarning } = warningSink();
    const url = buildODataQuery(
      {
        ...getDefaultQuery('Item'),
        // A freshly added row has no value yet: expected, not a problem.
        filters: [{ property: 'Price', operator: 'gt', value: '' }],
        select: ['Sku'],
        top: 5,
      },
      await model(),
      onWarning,
    );

    expect(url).toBe('/Items?$select=Sku&$top=5');
    expect(warnings).toEqual([]);
  });

  it('keeps a half-typed decimal out of the query and names it anyway', async () => {
    // Design decision: *every* non-empty row that cannot be formatted is
    // reported. Distinguishing "still typing" (`10.`) from "complete but
    // invalid" (`1.5`) would need a per-type completeness heuristic that can
    // misclassify and re-introduce silent drops; a transient, accurate note
    // while typing is the cheaper error.
    const { warnings, onWarning } = warningSink();
    const url = buildODataQuery(
      {
        ...getDefaultQuery('Item'),
        filters: [{ property: 'Price', operator: 'gt', value: '10.' }],
        select: ['Sku'],
        top: 5,
      },
      await model(),
      onWarning,
    );

    expect(url).toBe('/Items?$select=Sku&$top=5');
    expect(warnings).toEqual([
      'Filter on "Price" was left out of the query: Invalid Edm.Decimal value: 10.',
    ]);
  });

  it('reports every left-out row, in order, keeping the rows it can format', async () => {
    const { warnings, onWarning } = warningSink();
    const url = buildODataQuery(
      {
        ...getDefaultQuery('Item'),
        filters: [
          { property: 'Id', operator: 'eq', value: '2147483648' },
          { property: 'Sku', operator: 'eq', value: 'X1' },
          { property: 'Qty', operator: 'eq', value: '999' },
        ],
        top: 5,
      },
      await model(),
      onWarning,
    );

    expect(url).toBe("/Items?$filter=Sku eq 'X1'&$top=5");
    expect(warnings).toEqual([
      'Filter on "Id" was left out of the query: Invalid Edm.Int32 value: 2147483648 (out of range -2147483648..2147483647)',
      'Filter on "Qty" was left out of the query: Invalid Edm.Byte value: 999 (out of range 0..255)',
    ]);
  });

  it('builds a fully valid query byte-identically and reports nothing', async () => {
    const { warnings, onWarning } = warningSink();
    const url = buildODataQuery(
      {
        ...getDefaultQuery('Item'),
        filters: [
          { property: 'Sku', operator: 'contains', value: 'A&B' },
          { property: 'Price', operator: 'gt', value: '100' },
          { property: 'Id', operator: 'eq', value: '7' },
        ],
        select: ['Id', 'Sku'],
        sort: 'Id',
        sortDirection: 'desc',
        top: 10,
        skip: 5,
      },
      await model(),
      onWarning,
    );

    // Captured before the fix; the warning channel must not alter output.
    expect(url).toBe(
      "/Items?$filter=contains(Sku,'A%26B') and Price gt 100 and Id eq 7&$select=Id,Sku&$orderby=Id desc&$top=10&$skip=5",
    );
    expect(warnings).toEqual([]);
  });

  it('forwards the shared builder’s warnings for unknown properties', async () => {
    // A filter on a property the model does not have is kept in the query and
    // diagnosed by `buildQueryUrl`; its channel existed but was never wired.
    const { warnings, onWarning } = warningSink();
    const url = buildODataQuery(
      {
        ...getDefaultQuery('Item'),
        filters: [{ property: 'Nope', operator: 'eq', value: 'x' }],
        top: 5,
      },
      await model(),
      onWarning,
    );

    expect(url).toBe("/Items?$filter=Nope eq 'x'&$top=5");
    expect(warnings).toEqual(['"Nope" is not a property of Inv.Item.']);
  });
});

describe('QueryPreview renders the reasons near the query', () => {
  afterEach(() => cleanup());

  it('shows each reason below the generated query', () => {
    render(
      <QueryPreview
        query="/Items?$top=25"
        warnings={[
          'Filter on "Id" was left out of the query: Invalid Edm.Int32 value: 2147483648 (out of range -2147483648..2147483647)',
        ]}
      />,
    );

    expect(screen.getByText('/Items?$top=25')).toBeDefined();
    expect(screen.getByText(/Filter on "Id" was left out/)).toBeDefined();
    expect(screen.getByText(/out of range -2147483648\.\.2147483647/)).toBeDefined();
  });

  it('shows every reason, not only the first', () => {
    render(
      <QueryPreview
        query="/Items?$top=25"
        warnings={[
          'Filter on "Id" was left out of the query: Invalid Edm.Int32 value: 2147483648 (out of range -2147483648..2147483647)',
          'Filter on "Qty" was left out of the query: Invalid Edm.Byte value: 999 (out of range 0..255)',
        ]}
      />,
    );

    expect(screen.getByText(/Filter on "Id" was left out/)).toBeDefined();
    expect(screen.getByText(/Filter on "Qty" was left out/)).toBeDefined();
  });

  it('shows a repeated reason once', () => {
    // Two identical rows produce identical messages; positional keys are not
    // worth an index-based React key for that.
    const warning =
      'Filter on "Id" was left out of the query: Invalid Edm.Int32 value: 2147483648 (out of range -2147483648..2147483647)';
    render(<QueryPreview query="/Items?$top=25" warnings={[warning, warning]} />);

    expect(screen.getAllByText(/Filter on "Id" was left out/)).toHaveLength(1);
  });

  it('renders no warning block when nothing was left out', () => {
    render(<QueryPreview query="/Items?$top=25" warnings={[]} />);
    expect(screen.getByText('/Items?$top=25')).toBeDefined();
    expect(screen.queryByText(/left out/)).toBeNull();
  });
});

describe('QueryBuilder explains a filter it had to leave out', () => {
  afterEach(() => cleanup());

  it('shows the reason next to the preview after an out-of-range value', async () => {
    const metadata = await model();
    render(
      <ReactFlowProvider>
        <QueryBuilder metadata={metadata} />
      </ReactFlowProvider>,
    );

    // Add a filter row on `Id` (the first property) and type an out-of-range
    // value into it. The row must not appear in the preview unnoticed.
    // `selector` scopes past the Quick Guide's `<b>$filter</b>` mention.
    fireEvent.click(screen.getByText('$filter', { selector: 'button' }));
    fireEvent.click(screen.getByText('+ add filter'));
    fireEvent.change(screen.getByPlaceholderText('val'), {
      target: { value: '2147483648' },
    });

    const preview = document.querySelector('pre') as HTMLElement;
    expect(preview.textContent).not.toContain('Id eq');
    expect(screen.getByText(/Filter on "Id" was left out/)).toBeDefined();
  });
});
