import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { parseCSDL } from '@odata-visualizer/shared';
import { buildODataQuery, getDefaultQuery, type ExpandItem } from '../src/utils/queryResolver';
import { QueryPreview } from '../src/components/query/QueryPreview';
import { QueryBuilder } from '../src/components/QueryBuilder';

/**
 * `buildODataQuery` leaves filter rows out when their value cannot be typed as
 * a literal for the property. #23 tightened integer validation, so complete
 * but invalid values (`2147483648` on Edm.Int32) are now dropped too — and
 * were dropped with no trace, leaving a preview that looked correct.
 *
 * The fix keeps the row out (the preview must stay buildable while editing)
 * but reports *why*, naming the property (with its expand path) and the
 * operator, plus the formatter's reason with any very long value truncated.
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
        <NavigationProperty Name="Lines" Type="Collection(Inv.Line)" />
      </EntityType>
      <EntityType Name="Line">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.Int32" Nullable="false" />
        <Property Name="Sku" Type="Edm.String" />
        <NavigationProperty Name="SubLines" Type="Collection(Inv.SubLine)" />
      </EntityType>
      <EntityType Name="SubLine">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.Int32" Nullable="false" />
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Items" EntityType="Inv.Item" />
        <FunctionImport Name="TopItems" EntitySet="Items" />
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

function expandItem(navProperty: string, overrides: Partial<ExpandItem> = {}): ExpandItem {
  return {
    navProperty,
    select: [],
    expand: [],
    filters: [],
    filterLogic: 'and',
    sort: '',
    sortDirection: 'asc',
    top: 0,
    skip: 0,
    ...overrides,
  };
}

const INT32_OVERFLOW = 'Invalid Edm.Int32 value: 2147483648 (out of range -2147483648..2147483647)';

/** The visible warning list; the live region repeats only stable prefixes. */
function warningList(): HTMLElement {
  return screen.getByRole('list');
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
    expect(warnings).toEqual([`Filter on "Id" (eq) was left out of the query: ${INT32_OVERFLOW}`]);
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
      'Filter on "Qty" (eq) was left out of the query: Invalid Edm.Byte value: 999 (out of range 0..255)',
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
      'Filter on "Id" (eq) was left out of the query: Invalid Edm.Int32 value: 1.5 (expected an integer)',
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

  it('names a half-typed decimal even though the current UI cannot produce it', async () => {
    // Reachability: the filter input is `<input type="number">`, which reports
    // `10.` as `''` before React sees it, and empty rows are skipped silently.
    // So this note cannot appear in today's UI. The behaviour still matters for
    // programmatic callers of `buildODataQuery` (and any future text input):
    // a row with no formattable literal is reported rather than dropped.
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
      'Filter on "Price" (gt) was left out of the query: Invalid Edm.Decimal value: 10.',
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

    expect(url).toBe("/Items?$filter=Sku%20eq%20'X1'&$top=5");
    expect(warnings).toEqual([
      `Filter on "Id" (eq) was left out of the query: ${INT32_OVERFLOW}`,
      'Filter on "Qty" (eq) was left out of the query: Invalid Edm.Byte value: 999 (out of range 0..255)',
    ]);
  });

  it('keeps two invalid rows with the same property distinct by operator', async () => {
    // Deduping by message used to collapse `Id gt 2147483648` and
    // `Id lt 2147483648`, understating how many rows were dropped and never
    // saying which row was at fault. The operator restores the identity.
    const { warnings, onWarning } = warningSink();
    const url = buildODataQuery(
      {
        ...getDefaultQuery('Item'),
        filters: [
          { property: 'Id', operator: 'gt', value: '2147483648' },
          { property: 'Id', operator: 'lt', value: '2147483648' },
        ],
        top: 5,
      },
      await model(),
      onWarning,
    );

    expect(url).toBe('/Items?$top=5');
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('Filter on "Id" (gt)');
    expect(warnings[1]).toContain('Filter on "Id" (lt)');
  });

  it('truncates a very long value in the warning instead of echoing it', async () => {
    // Measured before the fix: a 3000-character value made the panel (and the
    // document) hundreds of times wider than the viewport.
    const { warnings, onWarning } = warningSink();
    const value = '9'.repeat(3000);
    const url = buildODataQuery(
      {
        ...getDefaultQuery('Item'),
        filters: [{ property: 'Id', operator: 'eq', value }],
        top: 5,
      },
      await model(),
      onWarning,
    );

    expect(url).toBe('/Items?$top=5');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`Invalid Edm.Int32 value: ${'9'.repeat(40)}…`);
    expect(warnings[0]).not.toContain('9'.repeat(41));
    expect(warnings[0].length).toBeLessThan(200);
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

    // Captured before the encoding change; the warning channel must not alter output.
    expect(url).toBe(
      "/Items?$filter=contains(Sku,'A%26B')%20and%20Price%20gt%20100%20and%20Id%20eq%207&$select=Id,Sku&$orderby=Id%20desc&$top=10&$skip=5",
    );
    expect(warnings).toEqual([]);
  });

  it('forwards the shared builder’s warnings for unknown properties', async () => {
    // A filter on a property the model does not have is kept in the query and
    // diagnosed by `buildQueryUrl`. The UI's property dropdowns cannot produce
    // it, but the utility is public and programmatic callers can.
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

    expect(url).toBe("/Items?$filter=Nope%20eq%20'x'&$top=5");
    expect(warnings).toEqual(['"Nope" is not a property of Inv.Item.']);
  });

  it('validates an expand node’s filter and keeps every other option', async () => {
    // Reproduced through the UI before this test: a bad Int32 on the `Lines`
    // child escaped as a throw, `buildODataQuery` swallowed it, and the whole
    // preview collapsed to `/Items` — filters, select, orderby and $top gone.
    const { warnings, onWarning } = warningSink();
    const url = buildODataQuery(
      {
        ...getDefaultQuery('Item'),
        select: ['Sku'],
        sort: 'Id',
        top: 5,
        expand: [
          expandItem('Lines', {
            select: ['Sku'],
            filters: [{ property: 'Id', operator: 'eq', value: '2147483648' }],
          }),
        ],
      },
      await model(),
      onWarning,
    );

    expect(url).toBe('/Items?$select=Sku&$expand=Lines($select=Sku)&$orderby=Id%20asc&$top=5');
    expect(warnings).toEqual([
      `Filter on "Lines/Id" (eq) was left out of the query: ${INT32_OVERFLOW}`,
    ]);
  });

  it('reports a nested expand path through every level', async () => {
    const { warnings, onWarning } = warningSink();
    const url = buildODataQuery(
      {
        ...getDefaultQuery('Item'),
        top: 5,
        expand: [
          expandItem('Lines', {
            expand: [
              expandItem('SubLines', {
                filters: [{ property: 'Id', operator: 'eq', value: '2147483648' }],
              }),
            ],
          }),
        ],
      },
      await model(),
      onWarning,
    );

    expect(url).toBe('/Items?$expand=Lines($expand=SubLines)&$top=5');
    expect(warnings).toEqual([
      `Filter on "Lines/SubLines/Id" (eq) was left out of the query: ${INT32_OVERFLOW}`,
    ]);
  });

  it('says why the full query was replaced by the bare resource path', async () => {
    // The swallow in `buildODataQuery`'s catch is the branch's own criticism of
    // throw-based validation, so it must not be silent either. An invalid
    // expand segment is one of the few states the pre-checks cannot fix.
    const { warnings, onWarning } = warningSink();
    const url = buildODataQuery(
      {
        ...getDefaultQuery('Item'),
        expand: [expandItem('Bad Name')],
      },
      await model(),
      onWarning,
    );

    expect(url).toBe('/Items');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/could not be built/);
    expect(warnings[0]).toContain('Bad Name');
  });
});

describe('QueryPreview renders the reasons near the query', () => {
  afterEach(() => cleanup());

  it('shows each reason below the generated query', () => {
    render(
      <QueryPreview
        query="/Items?$top=25"
        warnings={[`Filter on "Id" (eq) was left out of the query: ${INT32_OVERFLOW}`]}
        omittedFilterCount={1}
      />,
    );

    expect(screen.getByText('/Items?$top=25')).toBeDefined();
    expect(within(warningList()).getByText(/Filter on "Id" \(eq\) was left out/)).toBeDefined();
    expect(screen.getByText(/out of range -2147483648\.\.2147483647/)).toBeDefined();
  });

  it('shows every reason, not only the first', () => {
    render(
      <QueryPreview
        query="/Items?$top=25"
        warnings={[
          `Filter on "Id" (eq) was left out of the query: ${INT32_OVERFLOW}`,
          'Filter on "Qty" (eq) was left out of the query: Invalid Edm.Byte value: 999 (out of range 0..255)',
        ]}
        omittedFilterCount={2}
      />,
    );

    expect(within(warningList()).getByText(/Filter on "Id" \(eq\) was left out/)).toBeDefined();
    expect(within(warningList()).getByText(/Filter on "Qty" \(eq\) was left out/)).toBeDefined();
  });

  it('shows a repeated reason once', () => {
    // Two identical rows produce identical messages; showing the same line
    // twice is noise. (Different operators are kept apart by the message.)
    const warning = `Filter on "Id" (eq) was left out of the query: ${INT32_OVERFLOW}`;
    render(<QueryPreview query="/Items?$top=25" warnings={[warning, warning]} />);

    expect(within(warningList()).getAllByText(/Filter on "Id" \(eq\) was left out/)).toHaveLength(
      1,
    );
  });

  it('keeps the same list elements when the order of the same warnings changes', () => {
    const first = `Filter on "Id" (eq) was left out of the query: ${INT32_OVERFLOW}`;
    const second =
      'Filter on "Qty" (eq) was left out of the query: Invalid Edm.Byte value: 999 (out of range 0..255)';
    const { rerender } = render(<QueryPreview query="/Items?$top=25" warnings={[first, second]} />);

    const before = screen.getAllByRole('listitem');
    expect(before.map((li) => li.textContent)).toEqual([first, second]);

    rerender(<QueryPreview query="/Items?$top=25" warnings={[second, first]} />);

    const after = screen.getAllByRole('listitem');
    expect(after.map((li) => li.textContent)).toEqual([second, first]);
    // Keyed by message, the same DOM nodes move; with `key={index}` React
    // rewrites the text of each node instead, which loses their identity.
    expect(after[0]).toBe(before[1]);
    expect(after[1]).toBe(before[0]);
  });

  it('announces warnings without re-announcing on every keystroke', () => {
    // The raw value is part of each visible message, so a live region bound to
    // the full text re-announces while the user types. The announcement keeps
    // only the stable prefix (property, operator, problem); the editable value
    // and the formatter reason stay in the visible list.
    const prefix = 'Filter on "Id" (eq) was left out of the query';
    const { rerender } = render(
      <QueryPreview query="/Items?$top=25" warnings={[`${prefix}: Invalid Edm.Guid value: a`]} />,
    );

    const region = screen.getByLabelText('Query warnings');
    expect(region.getAttribute('aria-live')).toBe('polite');
    const announcement = region.textContent;
    expect(announcement).toContain(prefix);
    expect(announcement).not.toContain('Edm.Guid');

    rerender(
      <QueryPreview query="/Items?$top=25" warnings={[`${prefix}: Invalid Edm.Guid value: ab`]} />,
    );
    rerender(
      <QueryPreview query="/Items?$top=25" warnings={[`${prefix}: Invalid Edm.Guid value: abc`]} />,
    );
    expect(region.textContent).toBe(announcement);
  });

  it('renders no warning block when nothing was left out', () => {
    render(<QueryPreview query="/Items?$top=25" warnings={[]} />);
    expect(screen.getByText('/Items?$top=25')).toBeDefined();
    expect(screen.queryByText(/left out/)).toBeNull();
  });

  it('uses AA-contrast warning colours and wraps long values', () => {
    // #d97706 (amber-600) on #fffbeb (amber-50) is 3.07:1 at 12px, below the
    // 4.5:1 AA threshold; amber-700 is 4.84:1. The list must also break long
    // unbroken tokens rather than widen the panel.
    render(
      <QueryPreview
        query="/Items?$top=25"
        warnings={[`Filter on "Id" (eq) was left out of the query: ${INT32_OVERFLOW}`]}
        omittedFilterCount={1}
      />,
    );

    const list = screen.getByRole('list');
    expect(list.className).toContain('text-amber-700');
    expect(list.className).not.toContain('text-amber-600');
    expect(list.className).toContain('break-all');
  });

  it('labels Copy with the number of omitted filter rows', () => {
    // The copied text is a valid query that silently omits the row; the Copy
    // affordance is where that has to be visible.
    render(
      <QueryPreview
        query="/Items?$top=25"
        warnings={[`Filter on "Id" (eq) was left out of the query: ${INT32_OVERFLOW}`]}
        omittedFilterCount={1}
      />,
    );
    expect(screen.getByRole('button', { name: /copy \(1 filter omitted\)/i })).toBeDefined();

    cleanup();
    render(
      <QueryPreview
        query="/Items?$top=25"
        warnings={[
          `Filter on "Id" (eq) was left out of the query: ${INT32_OVERFLOW}`,
          'Filter on "Qty" (eq) was left out of the query: Invalid Edm.Byte value: 999 (out of range 0..255)',
        ]}
        omittedFilterCount={2}
      />,
    );
    expect(screen.getByRole('button', { name: /copy \(2 filters omitted\)/i })).toBeDefined();
  });

  it('does not label Copy when nothing was omitted', () => {
    render(<QueryPreview query="/Items?$top=25" />);
    expect(screen.getByRole('button', { name: /^copy$/i })).toBeDefined();
  });
});

/** The preview is the <pre> block that holds the generated query. */
function preview(): HTMLElement {
  return document.querySelector('pre') as HTMLElement;
}

describe('QueryBuilder explains a filter it had to leave out', () => {
  afterEach(() => cleanup());

  it('shows the reason next to a preview that keeps its other options', async () => {
    const metadata = await model();
    render(
      <ReactFlowProvider>
        <QueryBuilder metadata={metadata} />
      </ReactFlowProvider>,
    );

    // No value typed yet: the full query is on screen, so the assertions below
    // test the surviving options rather than passing vacuously.
    expect(preview().textContent).toBe('/Items?$top=25');

    // Add a filter row on `Id` (the first property) and type an out-of-range
    // value into it. The row must not appear in the preview unnoticed.
    // `selector` scopes past the Quick Guide's `<b>$filter</b>` mention.
    fireEvent.click(screen.getByText('$filter', { selector: 'button' }));
    fireEvent.click(screen.getByText('+ add filter'));
    fireEvent.change(screen.getByPlaceholderText('val'), {
      target: { value: '2147483648' },
    });

    expect(preview().textContent).toBe('/Items?$top=25');
    expect(within(warningList()).getByText(/Filter on "Id" \(eq\) was left out/)).toBeDefined();
    // The copyable query omits the row, so Copy says so.
    expect(screen.getByRole('button', { name: /copy \(1 filter omitted\)/i })).toBeDefined();
  });

  it('does not accumulate warnings across renders', async () => {
    const metadata = await model();
    render(
      <ReactFlowProvider>
        <QueryBuilder metadata={metadata} />
      </ReactFlowProvider>,
    );

    fireEvent.click(screen.getByText('$filter', { selector: 'button' }));
    fireEvent.click(screen.getByText('+ add filter'));
    const value = screen.getByPlaceholderText('val');
    fireEvent.change(value, { target: { value: '2147483648' } });
    expect(within(warningList()).getByText(/Filter on "Id"/)).toBeDefined();

    // Correcting the value must clear the warning, not leave it behind.
    fireEvent.change(value, { target: { value: '7' } });
    expect(within(warningList()).queryByText(/Filter on "Id"/)).toBeNull();
    expect(preview().textContent).toBe('/Items?$filter=Id%20eq%207&$top=25');
    expect(screen.queryByRole('button', { name: /filter omitted/i })).toBeNull();
  });

  it('keeps the whole preview when only a nested expand filter is invalid', async () => {
    // The reported reproduction: expand Lines → filter its Int32 Id with
    // 2147483648 → the preview collapsed from
    //   /Items?$top=25
    // to
    //   /Items
    // with no warning, because the child filter throw escaped `buildQueryUrl`.
    const metadata = await model();
    render(
      <ReactFlowProvider>
        <QueryBuilder metadata={metadata} />
      </ReactFlowProvider>,
    );

    expect(preview().textContent).toBe('/Items?$top=25');

    // Expand `Lines` off the root node, then wait for the child node (ELK
    // layout is async) to render its own controls.
    fireEvent.click(screen.getAllByText('$expand', { selector: 'button' })[0]);
    // React Flow marks node internals as hidden to the accessibility tree
    // until measured, so this has to match on text rather than role.
    fireEvent.click(screen.getByText(/Lines/, { selector: 'button' }));
    await waitFor(() =>
      expect(screen.getAllByText('$filter', { selector: 'button' })).toHaveLength(2),
    );

    // The child node is the second one in DOM order.
    fireEvent.click(screen.getAllByText('$filter', { selector: 'button' })[1]);
    fireEvent.click(screen.getByText('+ add filter'));
    expect(screen.getByPlaceholderText('val')).toBeDefined();
    fireEvent.change(screen.getByPlaceholderText('val'), {
      target: { value: '2147483648' },
    });

    // The root options and the expansion all survive; only the bad row is out.
    expect(preview().textContent).toBe('/Items?$expand=Lines&$top=25');
    expect(
      within(warningList()).getByText(/Filter on "Lines\/Id" \(eq\) was left out/),
    ).toBeDefined();
  });

  it('clears filter warnings while a function-import query is shown', async () => {
    const metadata = await model();
    render(
      <ReactFlowProvider>
        <QueryBuilder metadata={metadata} />
      </ReactFlowProvider>,
    );

    fireEvent.click(screen.getByText('$filter', { selector: 'button' }));
    fireEvent.click(screen.getByText('+ add filter'));
    fireEvent.change(screen.getByPlaceholderText('val'), {
      target: { value: '2147483648' },
    });
    expect(within(warningList()).getByText(/Filter on "Id" \(eq\) was left out/)).toBeDefined();

    // Switch to a function import: the preview is no longer a query built from
    // the graph, so its warnings must not linger under it.
    const functionSelect = screen.getByText('Select function...').closest('select')!;
    fireEvent.change(functionSelect, { target: { value: 'TopItems' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to Canvas' }));

    expect(preview().textContent).toBe('TopItems');
    expect(within(warningList()).queryByText(/Filter on "Id"/)).toBeNull();
    expect(screen.queryByRole('button', { name: /filter omitted/i })).toBeNull();
  });
});
