import { useMemo } from 'react';
import type {
  ODataMetadata,
  ODataNavigationProperty,
  ODataProperty,
} from '@odata-visualizer/shared';
import type { ExpandItem } from '../../utils/queryResolver';
import {
  getTargetEntityName,
  findEntity,
  getResolvedNavProperties,
} from '../../utils/queryResolver';
import { FilterBuilder } from './FilterBuilder';

const EMPTY_NAV_PROPS: ODataNavigationProperty[] = [];
const EMPTY_PROPS: ODataProperty[] = [];

interface ExpandSelectorProps {
  navProperties: ODataNavigationProperty[];
  selected: ExpandItem[];
  onChange: (selected: ExpandItem[]) => void;
  metadata: ODataMetadata;
  sourceEntityName: string;
  depth?: number;
  parentPath?: string;
}

export function ExpandSelector({
  navProperties,
  selected,
  onChange,
  metadata,
  sourceEntityName,
  depth = 0,
  parentPath = '',
}: ExpandSelectorProps) {
  const toggle = (navName: string) => {
    const existing = selected.find((s) => s.navProperty === navName);
    if (existing) {
      onChange(selected.filter((s) => s.navProperty !== navName));
    } else {
      onChange([
        ...selected,
        {
          navProperty: navName,
          select: [],
          expand: [],
          filters: [],
          filterLogic: 'and',
          sort: '',
          sortDirection: 'asc',
          top: 0,
          skip: 0,
        },
      ]);
    }
  };

  const updateItem = (navName: string, updates: Partial<ExpandItem>) => {
    onChange(selected.map((s) => (s.navProperty === navName ? { ...s, ...updates } : s)));
  };

  const handleSelectToggle = (navName: string, propName: string, select: string[]) => {
    const newSelect = select.includes(propName)
      ? select.filter((s) => s !== propName)
      : [...select, propName];
    updateItem(navName, { select: newSelect });
  };

  const sortDirectionOptions = useMemo(
    () => [
      <option key="asc" value="asc">
        ASC
      </option>,
      <option key="desc" value="desc">
        DESC
      </option>,
    ],
    [],
  );

  if (navProperties.length === 0) {
    return null;
  }

  return (
    <div className={depth > 0 ? 'ml-4 mt-2 border-l-2 border-gray-200 pl-3' : ''}>
      <label className="text-xs font-medium text-gray-500 mb-1 block">
        {depth === 0 ? 'Expand ($expand)' : 'Nested Expand'}
      </label>

      <div className="space-y-2">
        {navProperties.map((nav) => {
          const isSelected = selected.some((s) => s.navProperty === nav.name);
          const selectedItem = selected.find((s) => s.navProperty === nav.name);
          const sourceEntity = findEntity(sourceEntityName, metadata.entities);
          const targetEntityName = sourceEntity
            ? getTargetEntityName(nav.name, sourceEntity, metadata)
            : undefined;
          const targetEntity = targetEntityName
            ? findEntity(targetEntityName, metadata.entities)
            : undefined;

          const targetNavProps = targetEntity
            ? getResolvedNavProperties(targetEntity, metadata.entities)
            : EMPTY_NAV_PROPS;
          const targetProps = targetEntity ? targetEntity.properties : EMPTY_PROPS;

          return (
            <div key={nav.name}>
              <label
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs cursor-pointer border ${
                  isSelected
                    ? 'bg-primary-100 border-primary-300 text-primary-700'
                    : 'bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100'
                }`}
              >
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={isSelected}
                  onChange={() => toggle(nav.name)}
                />
                {nav.name}
                {targetEntityName && (
                  <span className="text-gray-400 ml-1">({targetEntityName})</span>
                )}
              </label>

              {isSelected && selectedItem && (
                <div className="mt-2 ml-2 space-y-3 border-l-2 border-primary-200 pl-3">
                  {!targetEntity && (
                    <div className="text-xs text-amber-600 bg-amber-50 p-2 rounded">
                      Could not resolve target entity for &quot;{nav.name}&quot;
                    </div>
                  )}

                  {targetEntity && targetProps.length > 0 && (
                    <div>
                      <label className="text-xs text-gray-400 block mb-1">
                        Select on {targetEntityName}
                      </label>
                      <div className="flex flex-wrap gap-1">
                        {targetProps.map((prop) => (
                          <label
                            key={prop.name}
                            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] cursor-pointer border ${
                              selectedItem.select.includes(prop.name)
                                ? 'bg-green-100 border-green-300 text-green-700'
                                : 'bg-gray-50 border-gray-200 text-gray-500 hover:bg-gray-100'
                            }`}
                          >
                            <input
                              type="checkbox"
                              className="sr-only"
                              checked={selectedItem.select.includes(prop.name)}
                              onChange={() =>
                                handleSelectToggle(nav.name, prop.name, selectedItem.select)
                              }
                            />
                            {prop.name}
                          </label>
                        ))}
                      </div>
                    </div>
                  )}

                  {targetEntity && targetProps.length > 0 && (
                    <div>
                      <label className="text-xs text-gray-400 block mb-1">
                        Filter on {targetEntityName}
                      </label>
                      <FilterBuilder
                        properties={targetProps}
                        filters={selectedItem.filters}
                        filterLogic={selectedItem.filterLogic}
                        onChange={(filters) => updateItem(nav.name, { filters })}
                        onFilterLogicChange={(logic) =>
                          updateItem(nav.name, { filterLogic: logic })
                        }
                      />
                    </div>
                  )}

                  {targetEntity && targetProps.length > 0 && (
                    <div className="flex gap-3 items-end">
                      <div>
                        <label className="text-xs text-gray-400 block mb-1">Sort</label>
                        <select
                          className="input text-xs"
                          value={selectedItem.sort}
                          onChange={(e) => updateItem(nav.name, { sort: e.target.value })}
                        >
                          <option value="">None</option>
                          {targetProps.map((p) => (
                            <option key={p.name} value={p.name}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      {selectedItem.sort && (
                        <div>
                          <label className="text-xs text-gray-400 block mb-1">Direction</label>
                          <select
                            className="input text-xs"
                            value={selectedItem.sortDirection}
                            onChange={(e) =>
                              updateItem(nav.name, {
                                sortDirection: e.target.value as 'asc' | 'desc',
                              })
                            }
                          >
                            {sortDirectionOptions}
                          </select>
                        </div>
                      )}
                      <div>
                        <label className="text-xs text-gray-400 block mb-1">Top</label>
                        <input
                          type="number"
                          className="input text-xs w-16"
                          value={selectedItem.top || ''}
                          min={0}
                          placeholder="0"
                          onChange={(e) =>
                            updateItem(nav.name, { top: parseInt(e.target.value) || 0 })
                          }
                        />
                      </div>
                      <div>
                        <label className="text-xs text-gray-400 block mb-1">Skip</label>
                        <input
                          type="number"
                          className="input text-xs w-16"
                          value={selectedItem.skip || ''}
                          min={0}
                          placeholder="0"
                          onChange={(e) =>
                            updateItem(nav.name, { skip: parseInt(e.target.value) || 0 })
                          }
                        />
                      </div>
                    </div>
                  )}

                  {targetEntity && targetNavProps.length > 0 && targetEntityName && (
                    <ExpandSelector
                      navProperties={targetNavProps}
                      selected={selectedItem.expand}
                      onChange={(subExpand) => updateItem(nav.name, { expand: subExpand })}
                      metadata={metadata}
                      sourceEntityName={targetEntityName}
                      depth={depth + 1}
                      parentPath={`${parentPath}/${nav.name}`}
                    />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
