import type { ODataProperty } from '@odata-visualizer/shared';

interface PropertySelectorProps {
  properties: ODataProperty[];
  selected: string[];
  onChange: (selected: string[]) => void;
}

export function PropertySelector({ properties, selected, onChange }: PropertySelectorProps) {
  const toggle = (name: string) => {
    if (selected.includes(name)) {
      onChange(selected.filter((n) => n !== name));
    } else {
      onChange([...selected, name]);
    }
  };

  const selectAll = () => {
    onChange(properties.map((p) => p.name));
  };

  const clearAll = () => {
    onChange([]);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-xs font-medium text-gray-500">Select ($select)</label>
        <div className="flex gap-2">
          <button type="button" onClick={selectAll} className="text-xs text-primary-600 hover:text-primary-700">All</button>
          <button type="button" onClick={clearAll} className="text-xs text-gray-400 hover:text-gray-600">None</button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1">
        {properties.map((prop) => (
          <label
            key={prop.name}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs cursor-pointer border ${
              selected.includes(prop.name)
                ? 'bg-primary-100 border-primary-300 text-primary-700'
                : 'bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100'
            }`}
          >
            <input
              type="checkbox"
              className="sr-only"
              checked={selected.includes(prop.name)}
              onChange={() => toggle(prop.name)}
            />
            {prop.name}
            {prop.isKey && <span className="text-yellow-500">*</span>}
          </label>
        ))}
      </div>
    </div>
  );
}
