import type { ODataProperty } from '@odata-visualizer/shared';
import type { QueryFilter } from '../../utils/queryResolver';
import { getOperatorsForType, getInputTypeForEdm } from '../../utils/queryResolver';

interface FilterBuilderProps {
  properties: ODataProperty[];
  filters: QueryFilter[];
  onChange: (filters: QueryFilter[]) => void;
}

export function FilterBuilder({ properties, filters, onChange }: FilterBuilderProps) {
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

      {filters.length === 0 && (
        <p className="text-xs text-gray-400">No filters</p>
      )}

      <div className="space-y-2">
        {filters.map((filter, index) => {
          const edmType = getSelectedPropertyType(filter.property);
          const operators = getOperatorsForType(edmType);

          return (
            <div key={index} className="flex gap-1 items-center">
              <select
                className="input text-xs flex-1"
                value={filter.property}
                onChange={(e) => updateFilter(index, 'property', e.target.value)}
              >
                {properties.map((p) => (
                  <option key={p.name} value={p.name}>{p.name}</option>
                ))}
              </select>

              <select
                className="input text-xs w-24"
                value={filter.operator}
                onChange={(e) => updateFilter(index, 'operator', e.target.value)}
              >
                {operators.map((op) => (
                  <option key={op} value={op}>{op}</option>
                ))}
              </select>

              <input
                type={getInputTypeForEdm(edmType)}
                className="input text-xs flex-1"
                value={filter.value}
                onChange={(e) => updateFilter(index, 'value', e.target.value)}
                placeholder="value"
              />

              <button
                type="button"
                onClick={() => removeFilter(index)}
                className="text-red-500 hover:text-red-700 text-xs p-1"
              >
                x
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
