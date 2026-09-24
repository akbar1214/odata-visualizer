import type { ODataProperty } from '@odata-visualizer/shared';
import type { QueryFilter, FilterLogic } from '../../utils/queryResolver';
import { getOperatorsForType, getInputTypeForEdm } from '../../utils/queryResolver';

interface FilterBuilderProps {
  properties: ODataProperty[];
  filters: QueryFilter[];
  filterLogic: FilterLogic;
  onChange: (filters: QueryFilter[]) => void;
  onFilterLogicChange: (logic: FilterLogic) => void;
}

export function FilterBuilder({
  properties,
  filters,
  filterLogic,
  onChange,
  onFilterLogicChange,
}: FilterBuilderProps) {
  const addFilter = () => {
    if (properties.length === 0) return;
    const prop = properties[0];
    const ops = getOperatorsForType(prop.type);
    onChange([...filters, { property: prop.name, operator: ops[0], value: '' }]);
  };

  const removeFilter = (index: number) => {
    onChange(filters.filter((_, i) => i !== index));
  };

  const updateFilter = (index: number, field: keyof QueryFilter, value: string) => {
    const updated = filters.map((f, i) => {
      if (i !== index) return f;
      const newFilter = { ...f, [field]: value };
      if (field === 'property') {
        const prop = properties.find((p) => p.name === value);
        if (prop) {
          const ops = getOperatorsForType(prop.type);
          if (!ops.includes(newFilter.operator)) {
            newFilter.operator = ops[0];
          }
        }
      }
      return newFilter;
    });
    onChange(updated);
  };

  const getSelectedPropertyType = (propName: string): string => {
    return properties.find((p) => p.name === propName)?.type || 'Edm.String';
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-xs font-medium text-gray-500">Filters</label>
        <button
          type="button"
          onClick={addFilter}
          className="text-xs text-primary-600 hover:text-primary-700"
        >
          + Add
        </button>
      </div>

      {filters.length === 0 && <p className="text-xs text-gray-400">No filters</p>}

      <div className="space-y-2">
        {filters.map((filter, index) => {
          const edmType = getSelectedPropertyType(filter.property);
          const operators = getOperatorsForType(edmType);

          return (
            // Keyed by property/operator rather than value: including the value
            // remounted the row on every keystroke and stole focus after one
            // character. Re-keying on a select change is fine.
            <div key={`${filter.property}-${filter.operator}`}>
              {index > 0 && (
                <div className="flex justify-center my-1">
                  <button
                    type="button"
                    onClick={() => onFilterLogicChange(filterLogic === 'and' ? 'or' : 'and')}
                    className={`text-[10px] font-bold px-3 py-0.5 rounded-full border transition-colors ${
                      filterLogic === 'and'
                        ? 'bg-primary-500 border-primary-400 text-white'
                        : 'bg-engineering-200 border-engineering-300 text-engineering-600'
                    }`}
                  >
                    {filterLogic.toUpperCase()}
                  </button>
                </div>
              )}
              <div className="flex gap-1 items-center min-w-0">
                <select
                  className="input text-xs flex-1 min-w-0"
                  value={filter.property}
                  onChange={(e) => updateFilter(index, 'property', e.target.value)}
                >
                  {properties.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name}
                    </option>
                  ))}
                </select>

                <select
                  className="input text-xs w-24"
                  value={filter.operator}
                  onChange={(e) => updateFilter(index, 'operator', e.target.value)}
                >
                  {operators.map((op) => (
                    <option key={op} value={op}>
                      {op}
                    </option>
                  ))}
                </select>

                <input
                  type={getInputTypeForEdm(edmType)}
                  className="input text-xs flex-1 min-w-0"
                  value={filter.value}
                  onChange={(e) => updateFilter(index, 'value', e.target.value)}
                  placeholder="value"
                />

                <button
                  type="button"
                  onClick={() => removeFilter(index)}
                  className="text-engineering-300 hover:text-engineering-500 text-xs p-1"
                >
                  x
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
