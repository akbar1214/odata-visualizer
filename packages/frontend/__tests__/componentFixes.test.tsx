import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { useState, type ComponentProps, type ReactNode } from 'react';
import type { ODataEntity, ODataMetadata } from '@odata-visualizer/shared';
import { EntityNode } from '../src/components/EntityNode';
import { QueryPreview } from '../src/components/query/QueryPreview';
import { SearchableSelect } from '../src/components/query/SearchableSelect';
import { PathFinder } from '../src/components/query/PathFinder';

function entity(name: string, overrides: Partial<ODataEntity> = {}): ODataEntity {
  return {
    name,
    qualifiedName: `Shop.${name}`,
    namespace: 'Shop',
    kind: 'entity',
    properties: [],
    navigationProperties: [],
    keys: ['Id'],
    ...overrides,
  };
}

function prop(name: string, isKey = false) {
  return {
    name,
    type: 'Edm.String',
    nullable: true,
    isKey,
  };
}

/** `Handle` needs a React Flow context; the layout is irrelevant here. */
function renderNode(node: ReactNode) {
  return render(<ReactFlowProvider>{node}</ReactFlowProvider>);
}

/** React Flow injects these defaults at render time; the test has to supply them. */
function nodeProps(entity: ODataEntity): ComponentProps<typeof EntityNode> {
  return {
    id: entity.name,
    type: 'entity',
    isConnectable: true,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    data: { entity },
    selected: false,
    dragging: false,
    draggable: true,
    selectable: true,
    deletable: true,
    zIndex: 0,
  };
}

describe('EntityNode property budget', () => {
  afterEach(() => cleanup());

  it('shows no regular properties when the keys already fill the budget', () => {
    // 8 keys over a budget of 6 leaves -2, and `slice(0, -2)` on six elements
    // means "the first four" — the opposite of showing none.
    const wide = entity('Wide', {
      properties: [
        ...Array.from({ length: 8 }, (_, i) => prop(`K${i}`, true)),
        prop('P1'),
        prop('P2'),
        prop('P3'),
        prop('P4'),
        prop('P5'),
        prop('P6'),
      ],
    });

    renderNode(<EntityNode {...nodeProps(wide)} />);

    expect(screen.queryByText('P1')).toBeNull();
    expect(screen.queryByText('P4')).toBeNull();
    expect(screen.getByText(/\+6 more properties/)).toBeDefined();
  });

  it('fills the remaining budget when keys fit', () => {
    const ok = entity('Ok', {
      properties: [prop('Id', true), prop('A'), prop('B'), prop('C'), prop('D')],
    });

    renderNode(<EntityNode {...nodeProps(ok)} />);

    expect(screen.getByText('A')).toBeDefined();
    expect(screen.getByText('D')).toBeDefined();
    expect(screen.queryByText(/hidden/)).toBeNull();
  });
});

describe('EntityNode header', () => {
  afterEach(() => cleanup());

  it('falls back to the type name when the type has no label', () => {
    renderNode(<EntityNode {...nodeProps(entity('Widget'))} />);

    expect(screen.getByText('Widget')).toBeDefined();
  });

  it('prefers a label over the type name', () => {
    renderNode(<EntityNode {...nodeProps(entity('Widget', { label: 'A flange assembly' }))} />);

    expect(screen.getByText('A flange assembly')).toBeDefined();
    expect(screen.queryByText('Widget')).toBeNull();
  });
});

describe('QueryPreview empty state', () => {
  afterEach(() => cleanup());

  it('falls back to the generic prompt when no message is given', () => {
    render(<QueryPreview query="" />);
    expect(screen.getByText('Select an entity to generate a query')).toBeDefined();
  });

  it('shows a caller-supplied message when there is no query', () => {
    // An entity that has no entity set produces no URL; saying "select an
    // entity" while one is selected reads as a bug.
    render(<QueryPreview query="" emptyMessage='"Part" is not exposed as an entity set.' />);
    expect(screen.getByText('"Part" is not exposed as an entity set.')).toBeDefined();
  });

  it('ignores the empty message once there is a query', () => {
    render(<QueryPreview query="/Orders?$top=25" emptyMessage="unused" />);
    expect(screen.getByText('/Orders?$top=25')).toBeDefined();
    expect(screen.queryByText('unused')).toBeNull();
  });
});

describe('QueryPreview copy feedback', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Headless browsers may not expose a usable clipboard; make it deterministic. */
  function stubClipboard() {
    vi.stubGlobal('navigator', {
      ...window.navigator,
      clipboard: { writeText: vi.fn(async () => undefined) },
    });
  }

  it('keeps only the latest copy timer outstanding', async () => {
    stubClipboard();
    vi.useFakeTimers();

    render(<QueryPreview query="/Parts?$top=5" />);
    const button = screen.getByRole('button', { name: /copy/i });

    await act(async () => {
      fireEvent.click(button);
    });
    await act(async () => {
      fireEvent.click(button);
    });
    await act(async () => {
      fireEvent.click(button);
    });

    // Each click cancels the previous timer, so exactly one is outstanding.
    // Otherwise a stale timer from an earlier click resets "Copied" early.
    expect(vi.getTimerCount()).toBe(1);
  });

  it('does not revert the copied state early after a second click', async () => {
    stubClipboard();
    vi.useFakeTimers();

    render(<QueryPreview query="/Parts?$top=5" />);
    const button = screen.getByRole('button', { name: /copy/i });

    await act(async () => {
      fireEvent.click(button);
    });
    expect(screen.getByRole('button', { name: /copied/i })).toBeDefined();

    // 1.5 s later, copy again: the first click's timer would fire at 2 s.
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    await act(async () => {
      fireEvent.click(button);
    });
    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    expect(screen.getByRole('button', { name: /copied/i })).toBeDefined();
  });

  it('clears its timer on unmount', async () => {
    stubClipboard();
    vi.useFakeTimers();

    const { unmount } = render(<QueryPreview query="/Parts" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /copy/i }));
    });

    expect(vi.getTimerCount()).toBe(1);
    unmount();

    // The timer must not survive the component or it fires against nothing.
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('SearchableSelect', () => {
  afterEach(() => cleanup());

  const entities = [entity('Part'), entity('Document')];

  it('shows the current selection as the input value, not a placeholder', () => {
    render(<SearchableSelect entities={entities} value="Part" onChange={() => undefined} />);

    const input = screen.getByRole('combobox') as HTMLInputElement;
    // It used to render the selection as grey placeholder text, so typing one
    // character made the current selection disappear with no other indicator.
    expect(input.value).toBe('Part');
    expect(input.placeholder).not.toContain('Part');
  });

  it('does not reopen the dropdown when the value is cleared', () => {
    const onChange = vi.fn();
    render(<SearchableSelect entities={entities} value="Part" onChange={onChange} />);

    const before = screen.getByRole('combobox').getAttribute('aria-expanded');
    fireEvent.click(screen.getByRole('button', { name: '✕' }));

    expect(onChange).toHaveBeenCalledWith('');
    // Clearing called `.focus()`, whose focus handler set `open` back to true.
    expect(screen.getByRole('combobox').getAttribute('aria-expanded')).toBe(before);
  });

  it('exposes combobox semantics', () => {
    render(<SearchableSelect entities={entities} value="" onChange={() => undefined} />);
    const input = screen.getByRole('combobox');
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('PathFinder root sync', () => {
  afterEach(() => cleanup());

  function Harness({ metadata }: { metadata: ODataMetadata }) {
    const [current, setCurrent] = useState('Part');
    return (
      <div>
        <button onClick={() => setCurrent('Document')}>change root</button>
        <span data-testid="root">{current}</span>
        <PathFinder metadata={metadata} currentEntity={current} onSelectPath={() => undefined} />
      </div>
    );
  }

  const metadata: ODataMetadata = {
    entities: [entity('Part'), entity('Document')],
    relationships: [],
    entityContainers: [],
    functionImports: [],
    actionImports: [],
    actions: [],
    functions: [],
    enumTypes: [],
    typeDefinitions: [],
  };

  it('follows the query root when it changes', () => {
    render(<Harness metadata={metadata} />);

    const sourceInput = screen.getAllByRole('combobox')[0] as HTMLInputElement;
    expect(sourceInput.value).toBe('Part');

    fireEvent.click(screen.getByText('change root'));

    // The "From entity" control used to keep the previous entity, and running a
    // path then silently reset the query root back to it.
    expect(sourceInput.value).toBe('Document');
  });
});
