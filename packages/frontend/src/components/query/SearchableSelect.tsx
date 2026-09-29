import { useState, useRef, useEffect, useCallback, useId } from 'react';
import { isComplexType } from '../../utils/queryResolver';
import type { ODataEntity } from '@odata-visualizer/shared';

interface SearchableSelectProps {
  entities: ODataEntity[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

export function SearchableSelect({
  entities,
  value,
  onChange,
  placeholder = 'Search entities...',
  disabled = false,
}: SearchableSelectProps) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedEntity = entities.find((e) => e.name === value);

  const filtered = entities.filter((e) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      e.name.toLowerCase().includes(q) ||
      e.namespace?.toLowerCase().includes(q) ||
      e.label?.toLowerCase().includes(q)
    );
  });

  const handleSelect = useCallback(
    (name: string) => {
      onChange(name);
      setSearch('');
      setOpen(false);
    },
    [onChange],
  );

  const handleFocus = useCallback(() => {
    if (!disabled) setOpen(true);
  }, [disabled]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setSearch(e.target.value);
    setOpen(true);
  }, []);

  const handleClear = useCallback(() => {
    onChange('');
    setSearch('');
    setOpen(false);
    // Focusing here used to re-trigger the focus handler, which reopened the
    // dropdown the user had just dismissed by clearing the value.
  }, [onChange]);

  const listboxId = useId();
  const inputId = useId();

  const handleOptionMouseDown = useCallback(
    (name: string) => (ev: React.MouseEvent) => {
      ev.preventDefault();
      handleSelect(name);
    },
    [handleSelect],
  );

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch('');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <input
        ref={inputRef}
        id={inputId}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-autocomplete="list"
        autoComplete="off"
        className="input text-xs w-full pr-6"
        // The selection was rendered as placeholder text, so it vanished the
        // moment the user typed one character and the field looked empty.
        placeholder={
          !value && selectedEntity
            ? `${selectedEntity.name}${isComplexType(selectedEntity) ? ' (ComplexType)' : ''}`
            : placeholder
        }
        value={open ? search : search || (value ?? '')}
        onFocus={handleFocus}
        onChange={handleInputChange}
        disabled={disabled}
      />
      {value && !open && (
        <button
          type="button"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 text-engineering-400 hover:text-engineering-600 text-[10px]"
          onClick={handleClear}
        >
          ✕
        </button>
      )}
      {open && (
        <div
          id={listboxId}
          role="listbox"
          aria-labelledby={inputId}
          className="absolute z-50 mt-1 w-full bg-white border border-engineering-200 rounded shadow-odv max-h-48 overflow-auto"
        >
          {filtered.length === 0 && (
            <div className="px-2 py-1.5 text-[10px] text-engineering-400">No matches</div>
          )}
          {filtered.map((e) => (
            <button
              key={e.name}
              type="button"
              role="option"
              aria-selected={e.name === value}
              className={`w-full text-left px-2 py-1.5 text-[11px] hover:bg-primary-50 flex items-center justify-between ${
                e.name === value ? 'bg-primary-100 text-primary-600' : 'text-engineering-600'
              }`}
              onMouseDown={handleOptionMouseDown(e.name)}
            >
              <span className="truncate">
                {e.namespace && <span className="text-engineering-400">{e.namespace}.</span>}
                {e.name}
              </span>
              {isComplexType(e) && (
                <span className="text-[9px] text-engineering-400 ml-1 flex-shrink-0">
                  ComplexType
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
