import type { ODataProperty } from '@odata-visualizer/shared';

interface SortBuilderProps {
  properties: ODataProperty[];
  sort: string;
  direction: 'asc' | 'desc';
  onChange: (sort: string, direction: 'asc' | 'desc') => void;
}

export function SortBuilder({ properties, sort, direction, onChange }: SortBuilderProps) {
  return (
    <div>
      <label className="text-xs font-medium text-gray-500 mb-1 block">Sort ($orderby)</label>
      <div className="flex gap-2">
        <select
          className="input text-xs flex-1"
          value={sort}
          onChange={(e) => onChange(e.target.value, direction)}
        >
          <option value="">None</option>
          {properties.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>

        <select
          className="input text-xs w-24"
          value={direction}
          onChange={(e) => onChange(sort, e.target.value as 'asc' | 'desc')}
          disabled={!sort}
        >
          <option value="asc">Ascending</option>
          <option value="desc">Descending</option>
        </select>
      </div>
    </div>
  );
}
