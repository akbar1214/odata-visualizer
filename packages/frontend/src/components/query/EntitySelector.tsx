import type { ODataEntity } from '@odata-visualizer/shared';
import { groupEntitiesByNamespace, isComplexType } from '../../utils/queryResolver';

interface EntitySelectorProps {
  entities: ODataEntity[];
  selected: string;
  onSelect: (name: string) => void;
}

export function EntitySelector({ entities, selected, onSelect }: EntitySelectorProps) {
  const grouped = groupEntitiesByNamespace(entities);

  return (
    <div>
      <label className="block text-xs font-medium text-engineering-500 mb-1">Entity</label>
      <select
        className="input text-sm"
        value={selected}
        onChange={(e) => onSelect(e.target.value)}
      >
        <option value="">Select entity...</option>
        {Array.from(grouped.entries()).map(([ns, ents]) => (
          <optgroup key={ns} label={ns}>
            {ents.map((e) => (
              <option key={e.name} value={e.name}>
                {e.name}{isComplexType(e) ? ' (ComplexType)' : ''}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}
