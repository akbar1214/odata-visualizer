import type { ODataEntity } from '@odata-visualizer/shared';
import { SearchableSelect } from './SearchableSelect';

interface EntitySelectorProps {
  entities: ODataEntity[];
  /** Full model to compute identity against; see `SearchableSelect`. */
  identityEntities?: ODataEntity[];
  selected: string;
  onSelect: (name: string) => void;
}

export function EntitySelector({
  entities,
  identityEntities,
  selected,
  onSelect,
}: EntitySelectorProps) {
  return (
    <div>
      <label className="block text-xs font-medium text-engineering-500 mb-1">Entity</label>
      <SearchableSelect
        entities={entities}
        identityEntities={identityEntities}
        value={selected}
        onChange={onSelect}
        placeholder="Search entities..."
      />
    </div>
  );
}
