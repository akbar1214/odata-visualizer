import { memo, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { ODataMetadata } from '@odata-visualizer/shared';
import {
  getResolvedEntity,
  getTargetEntityName,
  findEntity,
  getOperatorsForType,
  getInputTypeForEdm,
} from '../../utils/queryResolver';
import type { GraphNodeState } from '../../utils/graphState';

export interface GraphNodeData {
  nodeState: GraphNodeState;
  metadata: ODataMetadata;
  isRoot: boolean;
  onSelectToggle: (nodeId: string, propName: string) => void;
  onFilterAdd: (nodeId: string) => void;
  onFilterRemove: (nodeId: string, index: number) => void;
  onFilterUpdate: (nodeId: string, index: number, field: string, value: string) => void;
  onFilterLogicChange: (nodeId: string, logic: 'and' | 'or') => void;
  onSortChange: (nodeId: string, sort: string) => void;
  onSortDirectionChange: (nodeId: string, dir: 'asc' | 'desc') => void;
  onTopChange: (nodeId: string, top: number) => void;
  onSkipChange: (nodeId: string, skip: number) => void;
  onExpandNav: (nodeId: string, navProp: string) => void;
  onRemove: (nodeId: string) => void;
}

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

  const resolved = getResolvedEntity(nodeState.entityName, metadata.entities);
  if (!resolved) return null;

  const { allProperties, allNavProperties } = resolved;
  const availableNavProps = allNavProperties.filter(
    (nav) => !nodeState.expandedNavProps.includes(nav.name)
  );

  return (
    <div
      className={`rounded border shadow-odv text-xs min-w-[220px] max-w-[280px] overflow-hidden ${
        isRoot
          ? 'bg-primary-500 border-primary-600 text-white'
          : 'bg-white border-engineering-200 text-engineering-600'
      }`}
    >
      {!isRoot && <Handle type="target" position={Position.Top} className="!bg-engineering-400 !w-2 !h-2" />}

      {/* Header */}
      <div className={`px-2 py-1.5 rounded-t font-bold flex items-center justify-between ${
        isRoot ? 'bg-primary-600' : 'bg-engineering-100 border-b border-engineering-200'
      }`}>
        <span>{nodeState.entityName}</span>
        {!isRoot && (
          <button
            onClick={() => onRemove(nodeState.id)}
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
          <div className={`text-[10px] font-medium mb-1 ${isRoot ? 'text-primary-100' : 'text-engineering-400'}`}>
            $select
          </div>
          <div className="flex flex-wrap gap-0.5">
            {allProperties.map((prop) => (
              <button
                key={prop.name}
                onClick={() => onSelectToggle(nodeState.id, prop.name)}
                className={`px-1.5 py-0.5 rounded text-[10px] border transition-colors ${
                  nodeState.select.includes(prop.name)
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
            ))}
          </div>
        </div>

        {/* $filter */}
        <div>
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`text-[10px] font-medium flex items-center gap-1 ${
              isRoot ? 'text-primary-100 hover:text-white' : 'text-engineering-400 hover:text-engineering-600'
            }`}
          >
            $filter
            {nodeState.filters.length > 0 && (
              <span className={`px-1 rounded text-[9px] ${
                isRoot ? 'bg-white/20' : 'bg-engineering-200'
              }`}>
                {nodeState.filters.length}
              </span>
            )}
            <span className="text-[8px]">{showFilters ? '▼' : '▶'}</span>
          </button>
          {showFilters && (
            <div className="mt-1 space-y-0.5">
              {nodeState.filters.map((f, i) => {
                const edmType = allProperties.find((p) => p.name === f.property)?.type || 'Edm.String';
                const operators = getOperatorsForType(edmType);
                return (
                  <div key={i}>
                    {i > 0 && (
                      <div className="flex justify-center my-0.5">
                        <button
                          onClick={() => onFilterLogicChange(nodeState.id, nodeState.filterLogic === 'and' ? 'or' : 'and')}
                          className={`text-[9px] font-bold px-2 py-0 rounded-full border transition-colors ${
                            isRoot
                              ? nodeState.filterLogic === 'and'
                                ? 'bg-white/20 border-white/40 text-white'
                                : 'bg-white/5 border-white/20 text-white/60'
                              : nodeState.filterLogic === 'and'
                                ? 'bg-primary-500 border-primary-400 text-white'
                                : 'bg-engineering-200 border-engineering-300 text-engineering-600'
                          }`}
                        >
                          {nodeState.filterLogic.toUpperCase()}
                        </button>
                      </div>
                    )}
                    <div className="flex gap-0.5 items-center min-w-0">
                      <select
                        className={`text-[10px] rounded px-1 py-0.5 border flex-1 min-w-0 ${
                          isRoot ? 'bg-primary-500 border-primary-400 text-white' : 'bg-white border-engineering-200'
                        }`}
                        value={f.property}
                        onChange={(e) => onFilterUpdate(nodeState.id, i, 'property', e.target.value)}
                      >
                        {allProperties.map((p) => (
                          <option key={p.name} value={p.name}>{p.name}</option>
                        ))}
                      </select>
                      <select
                        className={`text-[10px] rounded px-1 py-0.5 border w-16 shrink-0 ${
                          isRoot ? 'bg-primary-500 border-primary-400 text-white' : 'bg-white border-engineering-200'
                        }`}
                        value={f.operator}
                        onChange={(e) => onFilterUpdate(nodeState.id, i, 'operator', e.target.value)}
                      >
                        {operators.map((op) => (
                          <option key={op} value={op}>{op}</option>
                        ))}
                      </select>
                      <input
                        type={getInputTypeForEdm(edmType)}
                        className={`text-[10px] rounded px-1 py-0.5 border flex-1 min-w-0 ${
                          isRoot ? 'bg-primary-500 border-primary-400 text-white placeholder-white/50' : 'bg-white border-engineering-200'
                        }`}
                        value={f.value}
                        placeholder="val"
                        onChange={(e) => onFilterUpdate(nodeState.id, i, 'value', e.target.value)}
                      />
                      <button
                        onClick={() => onFilterRemove(nodeState.id, i)}
                        className="text-engineering-300 hover:text-engineering-500 text-[10px]"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                );
              })}
              <button
                onClick={() => onFilterAdd(nodeState.id)}
                className={`text-[10px] ${
                  isRoot ? 'text-primary-100 hover:text-white' : 'text-primary-500 hover:text-primary-600'
                }`}
              >
                + add filter
              </button>
            </div>
          )}
        </div>

        {/* $orderby */}
        <div>
          <button
            onClick={() => setShowSort(!showSort)}
            className={`text-[10px] font-medium flex items-center gap-1 ${
              isRoot ? 'text-primary-100 hover:text-white' : 'text-engineering-400 hover:text-engineering-600'
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
                  isRoot ? 'bg-primary-500 border-primary-400 text-white' : 'bg-white border-engineering-200'
                }`}
                value={nodeState.sort}
                onChange={(e) => onSortChange(nodeState.id, e.target.value)}
              >
                <option value="">None</option>
                {allProperties.map((p) => (
                  <option key={p.name} value={p.name}>{p.name}</option>
                ))}
              </select>
              {nodeState.sort && (
                <select
                  className={`text-[10px] rounded px-1 py-0.5 border w-12 ${
                    isRoot ? 'bg-primary-500 border-primary-400 text-white' : 'bg-white border-engineering-200'
                  }`}
                  value={nodeState.sortDirection}
                  onChange={(e) => onSortDirectionChange(nodeState.id, e.target.value as 'asc' | 'desc')}
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
            <div className={`text-[10px] font-medium ${isRoot ? 'text-primary-100' : 'text-engineering-400'}`}>$top</div>
            <input
              type="number"
              min={0}
              className={`w-full text-[10px] rounded px-1 py-0.5 border ${
                isRoot ? 'bg-primary-500 border-primary-400 text-white' : 'bg-white border-engineering-200'
              }`}
              value={nodeState.top || ''}
              placeholder="0"
              onChange={(e) => onTopChange(nodeState.id, parseInt(e.target.value) || 0)}
            />
          </div>
          <div className="flex-1">
            <div className={`text-[10px] font-medium ${isRoot ? 'text-primary-100' : 'text-engineering-400'}`}>$skip</div>
            <input
              type="number"
              min={0}
              className={`w-full text-[10px] rounded px-1 py-0.5 border ${
                isRoot ? 'bg-primary-500 border-primary-400 text-white' : 'bg-white border-engineering-200'
              }`}
              value={nodeState.skip || ''}
              placeholder="0"
              onChange={(e) => onSkipChange(nodeState.id, parseInt(e.target.value) || 0)}
            />
          </div>
        </div>

        {/* $expand: Navigation properties */}
        {availableNavProps.length > 0 && (
          <div>
            <button
              onClick={() => setShowNav(!showNav)}
              className={`text-[10px] font-medium flex items-center gap-1 ${
                isRoot ? 'text-primary-100 hover:text-white' : 'text-engineering-400 hover:text-engineering-600'
              }`}
            >
              $expand
              {nodeState.expandedNavProps.length > 0 && (
                <span className={`px-1 rounded text-[9px] ${
                  isRoot ? 'bg-white/20' : 'bg-engineering-200'
                }`}>
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
                    metadata
                  );
                  return (
                    <button
                      key={nav.name}
                      onClick={() => onExpandNav(nodeState.id, nav.name)}
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
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {!isRoot && <Handle type="source" position={Position.Bottom} className="!bg-engineering-400 !w-2 !h-2" />}
    </div>
  );
}

export const GraphNode = memo(GraphNodeComponent);
