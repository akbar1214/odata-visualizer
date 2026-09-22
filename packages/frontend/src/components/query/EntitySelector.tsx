import type { ODataEntity } from '@odata-visualizer/shared';
import { SearchableSelect } from './SearchableSelect';

interface EntitySelectorProps {
  entities: ODataEntity[];
  selected: string;
  onSelect: (name: string) => void;
}

export function EntitySelector({ entities, selected, onSelect }: EntitySelectorProps) {
  return (
    <div>
      <label className="block text-xs font-medium text-engineering-500 mb-1">Entity</label>
      <SearchableSelect
        entities={entities}
        value={selected}
        onChange={onSelect}
        placeholder="Search entities..."
      />
    </div>
  );
}
