import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { ODataProperty } from '@odata-visualizer/shared';
import { FilterBuilder } from '../src/components/query/FilterBuilder';
import type { QueryFilter } from '../src/utils/queryResolver';

const properties: ODataProperty[] = [
  { name: 'Id', type: 'Edm.Int32', nullable: false, isKey: true },
  { name: 'Number', type: 'Edm.String', nullable: true },
  { name: 'Total', type: 'Edm.Decimal', nullable: true },
];

describe('FilterBuilder', () => {
  afterEach(() => cleanup());

  it('adds a filter row when + Add is clicked', () => {
    const onChange = vi.fn();
    render(
      <FilterBuilder
        properties={properties}
        filters={[]}
        filterLogic="and"
        onChange={onChange}
        onFilterLogicChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('+ Add'));
    expect(onChange).toHaveBeenCalledTimes(1);
    const [rows] = onChange.mock.calls[0] as [QueryFilter[]];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ property: 'Id', value: '' });
  });

  it('toggles the filter logic', () => {
    const onFilterLogicChange = vi.fn();
    // The AND/OR toggle only renders between two filter rows.
    render(
      <FilterBuilder
        properties={properties}
        filters={[
          { property: 'Number', operator: 'eq', value: 'A-1' },
          { property: 'Total', operator: 'gt', value: '1' },
        ]}
        filterLogic="and"
        onChange={vi.fn()}
        onFilterLogicChange={onFilterLogicChange}
      />,
    );

    fireEvent.click(screen.getByText('AND'));
    expect(onFilterLogicChange).toHaveBeenCalledWith('or');
  });

  it('keeps focus in the value input while typing', () => {
    // The row key used to include the value, so every keystroke remounted the
    // row and stole focus after the first character.
    const onChange = vi.fn();
    const renderRow = (value: string) => (
      <FilterBuilder
        properties={properties}
        filters={[{ property: 'Number', operator: 'eq', value }]}
        filterLogic="and"
        onChange={onChange}
        onFilterLogicChange={vi.fn()}
      />
    );

    const { rerender } = render(renderRow(''));
    const input = screen.getByPlaceholderText('value') as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: 'A' } });

    rerender(renderRow('A'));
    const next = screen.getByPlaceholderText('value') as HTMLInputElement;
    expect(next).toBe(input);
    expect(document.activeElement).toBe(next);
  });

  it('updates a filter value', () => {
    const onChange = vi.fn();
    const filters: QueryFilter[] = [{ property: 'Number', operator: 'eq', value: '' }];
    render(
      <FilterBuilder
        properties={properties}
        filters={filters}
        filterLogic="and"
        onChange={onChange}
        onFilterLogicChange={vi.fn()}
      />,
    );

    const valueInput = screen.getByPlaceholderText('value') as HTMLInputElement;
    fireEvent.change(valueInput, { target: { value: 'A-1' } });
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ property: 'Number', value: 'A-1' }),
    ]);
  });

  it('removes a filter row', async () => {
    const onChange = vi.fn();
    render(
      <FilterBuilder
        properties={properties}
        filters={[{ property: 'Number', operator: 'eq', value: 'A-1' }]}
        filterLogic="and"
        onChange={onChange}
        onFilterLogicChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('x'));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith([]));
  });
});
