import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { parseCSDL } from '@odata-visualizer/shared';
import { FunctionImportSelector } from '../src/components/query/FunctionImportSelector';

/**
 * The selector used to splice the value into the query by hand, so `O'Brien`
 * produced `Name='O'Brien'` (the literal ends at the second quote) and a space,
 * `&` or `#` produced a URL that cannot be sent — `&` silently split the query
 * string. #42 routes values through the shared literal formatter and the shared
 * path encoders MCP's inline parameters use.
 *
 * The import name deliberately differs from the function name: an unbound
 * function is addressed by its import name, and the selector's options come
 * from `metadata.functionImports`.
 */
const csdl = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Shop" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <Function Name="PartsByName">
        <Parameter Name="Name" Type="Edm.String" />
        <ReturnType Type="Edm.String" />
      </Function>
      <EntityContainer Name="Container">
        <FunctionImport Name="FindParts" Function="Shop.PartsByName">
          <Parameter Name="Name" Type="Edm.String" />
        </FunctionImport>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

async function renderSelector() {
  const metadata = await parseCSDL(csdl);
  const onSelect = vi.fn();
  render(<FunctionImportSelector metadata={metadata} onSelect={onSelect} />);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'FindParts' } });
  return onSelect;
}

/** The preview div is the only element whose text starts with the path. */
function preview(): string {
  return screen.getByText(/^\//).textContent ?? '';
}

function typeName(value: string) {
  fireEvent.change(screen.getByPlaceholderText('String'), { target: { value } });
}

describe('FunctionImportSelector builds an encoded, absolute query', () => {
  afterEach(() => cleanup());

  it('addresses the import name with a leading slash and hands it to onSelect', async () => {
    const onSelect = await renderSelector();

    expect(preview()).toBe('/FindParts');
    expect(preview()).not.toContain('PartsByName');

    fireEvent.click(screen.getByRole('button', { name: 'Add to Canvas' }));
    expect(onSelect).toHaveBeenCalledWith('/FindParts');
  });

  it('doubles a quote inside a string literal', async () => {
    await renderSelector();
    typeName("O'Brien");

    expect(preview()).toBe("/FindParts(Name='O''Brien')");
  });

  it('percent-encodes a space', async () => {
    await renderSelector();
    typeName('ball bearing');

    expect(preview()).toBe("/FindParts(Name='ball%20bearing')");
  });

  it('percent-encodes an ampersand so it cannot split the query string', async () => {
    await renderSelector();
    typeName('A&B');

    expect(preview()).toBe("/FindParts(Name='A%26B')");
  });

  it('percent-encodes a hash so it cannot truncate the URL as a fragment', async () => {
    await renderSelector();
    typeName('A#B');

    expect(preview()).toBe("/FindParts(Name='A%23B')");
  });
});
