import { memo, useCallback, useState, type ChangeEvent } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type {
  ODataMetadata,
  ODataProperty,
  ODataNavigationProperty,
} from '@odata-visualizer/shared';
import {
  getResolvedEntity,
  getTargetEntityName,
  findEntity,
  getOperatorsForType,
  getInputTypeForEdm,
} from '../../utils/queryResolver';
import type { GraphNodeState } from '../../utils/graphState';
import type { QueryFilter, FilterLogic } from '../../utils/queryResolver';

export interface GraphNodeData {
  nodeState: GraphNodeState;
  metadata: ODataMetadata;
  isRoot: boolean;
  onSelectToggle: (nodeId: string, propName: string) => void;
  onFilterAdd: (nodeId: string) => void;
  onFilterRemove: (nodeId: string, index: number) => void;
  onFilterUpdate: (nodeId: string, index: number, field: string, value: string) => void;
  onFilterLogicChange: (nodeId: string, logic: FilterLogic) => void;
  onSortChange: (nodeId: string, sort: string) => void;
  onSortDirectionChange: (nodeId: string, dir: 'asc' | 'desc') => void;
  onTopChange: (nodeId: string, top: number) => void;
  onSkipChange: (nodeId: string, skip: number) => void;
  onExpandNav: (nodeId: string, navProp: string) => void;
  onRemove: (nodeId: string) => void;
}

interface PropertyButtonProps {
  prop: ODataProperty;
  isRoot: boolean;
  selected: boolean;
  onToggle: (name: string) => void;
}

const PropertyButton = memo(function PropertyButton({
  prop,
  isRoot,
  selected,
  onToggle,
}: PropertyButtonProps) {
  return (
    <button
      key={prop.name}
      onClick={() => onToggle(prop.name)}
      className={`px-1.5 py-0.5 rounded text-[10px] border transition-colors ${
        selected
          ? isRoot
            ? 'bg-white/20 border-white/40 text-white'
            : 'bg-infineon-green/10 border-infineon-green/30 text-infineon-green'
          : isRoot
            ? 'bg-white/5 border-white/20 text-white/70 hover:bg-white/10'
            : 'bg-engineering-100 border-engineering-200 text-engineering-500 hover:bg-engineering-200'
      }`}
    >
      {prop.name}
      {prop.isKey && '*'}
    </button>
  );
});

interface FilterRowProps {
  filter: QueryFilter;
  index: number;
  isRoot: boolean;
  filterLogic: FilterLogic;
  allProperties: ODataProperty[];
  onPropertyChange: (index: number, value: string) => void;
  onOperatorChange: (index: number, value: string) => void;
  onValueChange: (index: number, value: string) => void;
  onRemove: (index: number) => void;
  onLogicToggle: () => void;
}

const FilterRow = memo(function FilterRow({
  filter,
  index,
  isRoot,
  filterLogic,
  allProperties,
  onPropertyChange,
  onOperatorChange,
  onValueChange,
  onRemove,
  onLogicToggle,
}: FilterRowProps) {
  const edmType = allProperties.find((p) => p.name === filter.property)?.type || 'Edm.String';
  const operators = getOperatorsForType(edmType);
  return (
    <div>
      {index > 0 && (
        <div className="flex justify-center my-0.5">
          <button
            onClick={onLogicToggle}
            className={`text-[9px] font-bold px-2 py-0 rounded-full border transition-colors ${
              isRoot
                ? filterLogic === 'and'
                  ? 'bg-white/20 border-white/40 text-white'
                  : 'bg-white/5 border-white/20 text-white/60'
                : filterLogic === 'and'
                  ? 'bg-primary-500 border-primary-400 text-white'
                  : 'bg-engineering-200 border-engineering-300 text-engineering-600'
            }`}
          >
            {filterLogic.toUpperCase()}
          </button>
        </div>
      )}
      <div className="flex gap-0.5 items-center min-w-0">
        <select
          className={`text-[10px] rounded px-1 py-0.5 border flex-1 min-w-0 ${
            isRoot
              ? 'bg-primary-500 border-primary-400 text-white'
              : 'bg-white border-engineering-200'
          }`}
          value={filter.property}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => onPropertyChange(index, e.target.value)}
        >
          {allProperties.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          className={`text-[10px] rounded px-1 py-0.5 border w-16 shrink-0 ${
            isRoot
              ? 'bg-primary-500 border-primary-400 text-white'
              : 'bg-white border-engineering-200'
          }`}
          value={filter.operator}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => onOperatorChange(index, e.target.value)}
        >
          {operators.map((op) => (
            <option key={op} value={op}>
              {op}
            </option>
          ))}
        </select>
        <input
          type={getInputTypeForEdm(edmType)}
          className={`text-[10px] rounded px-1 py-0.5 border flex-1 min-w-0 ${
            isRoot
              ? 'bg-primary-500 border-primary-400 text-white placeholder-white/50'
              : 'bg-white border-engineering-200'
          }`}
          value={filter.value}
          placeholder="val"
          onChange={(e: ChangeEvent<HTMLInputElement>) => onValueChange(index, e.target.value)}
        />
        <button
          onClick={() => onRemove(index)}
          className="text-engineering-300 hover:text-engineering-500 text-[10px]"
        >
          ✕
        </button>
      </div>
    </div>
  );
});

interface NavPropertyButtonProps {
  nav: ODataNavigationProperty;
  isRoot: boolean;
  targetName?: string;
  onExpand: (navName: string) => void;
}

const NavPropertyButton = memo(function NavPropertyButton({
  nav,
  isRoot,
  targetName,
  onExpand,
}: NavPropertyButtonProps) {
  return (
    <button
      key={nav.name}
      onClick={() => onExpand(nav.name)}
      className={`px-1.5 py-0.5 rounded text-[10px] border transition-colors ${
        isRoot
          ? 'bg-white/5 border-white/20 text-white/70 hover:bg-white/10'
          : 'bg-primary-50 border-primary-200 text-primary-500 hover:bg-primary-100'
      }`}
    >
      {nav.name}
      {targetName && (
        <span className={`ml-0.5 ${isRoot ? 'text-white/50' : 'text-engineering-400'}`}>
          →{targetName}
        </span>
      )}
    </button>
  );
});

function GraphNodeComponent({ data }: NodeProps) {
  const {
    nodeState,
    metadata,
    isRoot,
    onSelectToggle,
    onFilterAdd,
    onFilterRemove,
    onFilterUpdate,
    onFilterLogicChange,
    onSortChange,
    onSortDirectionChange,
    onTopChange,
    onSkipChange,
    onExpandNav,
    onRemove,
  } = data as unknown as GraphNodeData;

  const [showFilters, setShowFilters] = useState(false);
  const [showSort, setShowSort] = useState(false);
  const [showNav, setShowNav] = useState(false);

  const handleRemove = useCallback(() => {
    onRemove(nodeState.id);
  }, [onRemove, nodeState.id]);

  const handleSelectToggle = useCallback(
    (propName: string) => {
      onSelectToggle(nodeState.id, propName);
    },
    [onSelectToggle, nodeState.id],
  );

  const handleToggleFilters = useCallback(() => {
    setShowFilters((prev) => !prev);
  }, []);

  const handleFilterLogicToggle = useCallback(() => {
    onFilterLogicChange(nodeState.id, nodeState.filterLogic === 'and' ? 'or' : 'and');
  }, [onFilterLogicChange, nodeState.id, nodeState.filterLogic]);

  const handleFilterPropertyChange = useCallback(
    (index: number, value: string) => {
      onFilterUpdate(nodeState.id, index, 'property', value);
    },
    [onFilterUpdate, nodeState.id],
  );

  const handleFilterOperatorChange = useCallback(
    (index: number, value: string) => {
      onFilterUpdate(nodeState.id, index, 'operator', value);
    },
    [onFilterUpdate, nodeState.id],
  );

  const handleFilterValueChange = useCallback(
    (index: number, value: string) => {
      onFilterUpdate(nodeState.id, index, 'value', value);
    },
    [onFilterUpdate, nodeState.id],
  );

  const handleRemoveFilter = useCallback(
    (index: number) => {
      onFilterRemove(nodeState.id, index);
    },
    [onFilterRemove, nodeState.id],
  );

  const handleFilterAdd = useCallback(() => {
    onFilterAdd(nodeState.id);
  }, [onFilterAdd, nodeState.id]);

  const handleToggleSort = useCallback(() => {
    setShowSort((prev) => !prev);
  }, []);

  const handleSortChange = useCallback(
    (value: string) => {
      onSortChange(nodeState.id, value);
    },
    [onSortChange, nodeState.id],
  );

  const handleSortDirectionChange = useCallback(
    (value: 'asc' | 'desc') => {
      onSortDirectionChange(nodeState.id, value);
    },
    [onSortDirectionChange, nodeState.id],
  );

  const handleTopChange = useCallback(
    (value: string) => {
      onTopChange(nodeState.id, parseInt(value) || 0);
    },
    [onTopChange, nodeState.id],
  );

  const handleSkipChange = useCallback(
    (value: string) => {
      onSkipChange(nodeState.id, parseInt(value) || 0);
    },
    [onSkipChange, nodeState.id],
  );

  const handleToggleNav = useCallback(() => {
    setShowNav((prev) => !prev);
  }, []);

  const handleExpandNav = useCallback(
    (navName: string) => {
      onExpandNav(nodeState.id, navName);
    },
    [onExpandNav, nodeState.id],
  );

  const resolved = getResolvedEntity(nodeState.entityName, metadata.entities);
  if (!resolved) return null;

  const { allProperties, allNavProperties } = resolved;
  const availableNavProps = allNavProperties.filter(
    (nav) => !nodeState.expandedNavProps.includes(nav.name),
  );

  return (
    <div
      className={`rounded border shadow-odv text-xs min-w-[220px] max-w-[280px] overflow-hidden ${
        isRoot
          ? 'bg-primary-500 border-primary-600 text-white'
          : 'bg-white border-engineering-200 text-engineering-600'
      }`}
    >
      {!isRoot && (
        <Handle type="target" position={Position.Top} className="!bg-engineering-400 !w-2 !h-2" />
      )}
      {isRoot && (
        <Handle type="source" position={Position.Bottom} className="!bg-primary-300 !w-2 !h-2" />
      )}

      {/* Header */}
      <div
        className={`px-2 py-1.5 rounded-t font-bold flex items-center justify-between ${
          isRoot ? 'bg-primary-600' : 'bg-engineering-100 border-b border-engineering-200'
        }`}
      >
        <span>{nodeState.entityName}</span>
        {!isRoot && (
          <button
            onClick={handleRemove}
            className="text-engineering-400 hover:text-infineon-red text-[10px] ml-2"
            title="Remove"
          >
            ✕
          </button>
        )}
      </div>

      <div className="p-2 space-y-2">
        {/* $select: Property checkboxes */}
        <div>
          <div
            className={`text-[10px] font-medium mb-1 ${isRoot ? 'text-primary-100' : 'text-engineering-400'}`}
          >
            $select
          </div>
          <div className="flex flex-wrap gap-0.5">
            {allProperties.map((prop) => (
              <PropertyButton
                key={prop.name}
                prop={prop}
                isRoot={isRoot}
                selected={nodeState.select.includes(prop.name)}
                onToggle={handleSelectToggle}
              />
            ))}
          </div>
        </div>

        {/* $filter */}
        <div>
          <button
            onClick={handleToggleFilters}
            className={`text-[10px] font-medium flex items-center gap-1 ${
              isRoot
                ? 'text-primary-100 hover:text-white'
                : 'text-engineering-400 hover:text-engineering-600'
            }`}
          >
            $filter
            {nodeState.filters.length > 0 && (
              <span
                className={`px-1 rounded text-[9px] ${isRoot ? 'bg-white/20' : 'bg-engineering-200'}`}
              >
                {nodeState.filters.length}
              </span>
            )}
            <span className="text-[8px]">{showFilters ? '▼' : '▶'}</span>
          </button>
          {showFilters && (
            <div className="mt-1 space-y-0.5">
              {nodeState.filters.map((f, i) => (
                <FilterRow
                  // Keyed by property/operator rather than value: a
                  // value-dependent key remounted the row on every keystroke
                  // and stole focus after one character.
                  key={`${f.property}-${f.operator}`}
                  filter={f}
                  index={i}
                  isRoot={isRoot}
                  filterLogic={nodeState.filterLogic}
                  allProperties={allProperties}
                  onPropertyChange={handleFilterPropertyChange}
                  onOperatorChange={handleFilterOperatorChange}
                  onValueChange={handleFilterValueChange}
                  onRemove={handleRemoveFilter}
                  onLogicToggle={handleFilterLogicToggle}
                />
              ))}
              <button
                onClick={handleFilterAdd}
                className={`text-[10px] ${isRoot ? 'text-primary-100 hover:text-white' : 'text-primary-500 hover:text-primary-600'}`}
              >
                + add filter
              </button>
            </div>
          )}
        </div>

        {/* $orderby */}
        <div>
          <button
            onClick={handleToggleSort}
            className={`text-[10px] font-medium flex items-center gap-1 ${
              isRoot
                ? 'text-primary-100 hover:text-white'
                : 'text-engineering-400 hover:text-engineering-600'
            }`}
          >
            $orderby
            {nodeState.sort && (
              <span className={`text-[9px] ${isRoot ? 'text-white/80' : 'text-engineering-500'}`}>
                {nodeState.sort} {nodeState.sortDirection}
              </span>
            )}
            <span className="text-[8px]">{showSort ? '▼' : '▶'}</span>
          </button>
          {showSort && (
            <div className="mt-1 flex gap-1 min-w-0">
              <select
                className={`text-[10px] rounded px-1 py-0.5 border flex-1 min-w-0 ${
                  isRoot
                    ? 'bg-primary-500 border-primary-400 text-white'
                    : 'bg-white border-engineering-200'
                }`}
                value={nodeState.sort}
                onChange={(e: ChangeEvent<HTMLSelectElement>) => handleSortChange(e.target.value)}
              >
                <option value="">None</option>
                {allProperties.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
              {nodeState.sort && (
                <select
                  className={`text-[10px] rounded px-1 py-0.5 border w-12 ${
                    isRoot
                      ? 'bg-primary-500 border-primary-400 text-white'
                      : 'bg-white border-engineering-200'
                  }`}
                  value={nodeState.sortDirection}
                  onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                    handleSortDirectionChange(e.target.value as 'asc' | 'desc')
                  }
                >
                  <option value="asc">ASC</option>
                  <option value="desc">DESC</option>
                </select>
              )}
            </div>
          )}
        </div>

        {/* $top / $skip */}
        <div className="flex gap-2">
          <div className="flex-1">
            <div
              className={`text-[10px] font-medium ${isRoot ? 'text-primary-100' : 'text-engineering-400'}`}
            >
              $top
            </div>
            <input
              type="number"
              min={0}
              className={`w-full text-[10px] rounded px-1 py-0.5 border ${
                isRoot
                  ? 'bg-primary-500 border-primary-400 text-white'
                  : 'bg-white border-engineering-200'
              }`}
              value={nodeState.top || ''}
              placeholder="0"
              onChange={(e: ChangeEvent<HTMLInputElement>) => handleTopChange(e.target.value)}
            />
          </div>
          <div className="flex-1">
            <div
              className={`text-[10px] font-medium ${isRoot ? 'text-primary-100' : 'text-engineering-400'}`}
            >
              $skip
            </div>
            <input
              type="number"
              min={0}
              className={`w-full text-[10px] rounded px-1 py-0.5 border ${
                isRoot
                  ? 'bg-primary-500 border-primary-400 text-white'
                  : 'bg-white border-engineering-200'
              }`}
              value={nodeState.skip || ''}
              placeholder="0"
              onChange={(e: ChangeEvent<HTMLInputElement>) => handleSkipChange(e.target.value)}
            />
          </div>
        </div>

        {/* $expand: Navigation properties */}
        {availableNavProps.length > 0 && (
          <div>
            <button
              onClick={handleToggleNav}
              className={`text-[10px] font-medium flex items-center gap-1 ${
                isRoot
                  ? 'text-primary-100 hover:text-white'
                  : 'text-engineering-400 hover:text-engineering-600'
              }`}
            >
              $expand
              {nodeState.expandedNavProps.length > 0 && (
                <span
                  className={`px-1 rounded text-[9px] ${isRoot ? 'bg-white/20' : 'bg-engineering-200'}`}
                >
                  {nodeState.expandedNavProps.length}
                </span>
              )}
              <span className="text-[8px]">{showNav ? '▼' : '▶'}</span>
            </button>
            {showNav && (
              <div className="mt-1 flex flex-wrap gap-0.5 overflow-hidden">
                {availableNavProps.map((nav) => {
                  const targetName = getTargetEntityName(
                    nav.name,
                    findEntity(nodeState.entityName, metadata.entities)!,
                    metadata,
                  );
                  return (
                    <NavPropertyButton
                      key={nav.name}
                      nav={nav}
                      isRoot={isRoot}
                      targetName={targetName}
                      onExpand={handleExpandNav}
                    />
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {!isRoot && (
        <Handle
          type="source"
          position={Position.Bottom}
          className="!bg-engineering-400 !w-2 !h-2"
        />
      )}
    </div>
  );
}

export const GraphNode = memo(GraphNodeComponent);
