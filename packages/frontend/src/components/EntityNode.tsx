import { memo } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { ODataEntity } from '@odata-visualizer/shared';

export type EntityNodeData = Node<{
  entity: ODataEntity;
  selected?: boolean;
}>;

function EntityNodeComponent({ data, selected }: NodeProps<EntityNodeData>) {
  const entity = data.entity;
  const maxPropertiesToShow = 6;
  const keyProperties = entity.properties.filter((p) => p.isKey);
  const regularProperties = entity.properties.filter((p) => !p.isKey);
  const visibleProperties = regularProperties.slice(0, maxPropertiesToShow - keyProperties.length);
  const hiddenCount = regularProperties.length - visibleProperties.length;

  return (
    <div
      className={`bg-white rounded shadow-odv min-w-[200px] max-w-[280px] border-2 transition-all ${
        selected ? 'border-primary-500 shadow-odv-large' : 'border-engineering-200 hover:border-primary-300'
      }`}
    >
      {/* Entity Header */}
      <div className="bg-primary-500 text-white px-3 py-2 rounded-t-[4px]">
        <div className="font-semibold text-sm truncate" title={entity.name}>
          {entity.label || entity.name}
        </div>
        {entity.namespace && (
          <div className="text-xs text-primary-100 truncate" title={entity.namespace}>
            {entity.namespace}
          </div>
        )}
      </div>

      {/* Properties */}
      <div className="p-2 space-y-1">
        {/* Key Properties */}
        {keyProperties.map((prop) => (
          <div key={prop.name} className="flex items-center gap-1.5 text-xs">
            <span className="text-infineon-sand flex-shrink-0" title="Primary Key">
              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fillRule="evenodd"
                  d="M18 8a6 6 0 01-7.743 5.743L10 14l-1 1-1 1H6v2H2v-4l4.257-4.257A6 6 0 1118 8zm-6-4a1 1 0 100 2 2 2 0 012 2 1 1 0 102 0 4 4 0 00-4-4z"
                  clipRule="evenodd"
                />
              </svg>
            </span>
            <span className="font-mono font-medium text-black truncate" title={prop.name}>
              {prop.name}
            </span>
            <span className="text-engineering-400 flex-shrink-0">
              {prop.type.replace('Edm.', '')}
            </span>
          </div>
        ))}

        {/* Divider if we have both key and regular properties */}
        {keyProperties.length > 0 && regularProperties.length > 0 && (
          <div className="border-t border-engineering-100 my-1" />
        )}

        {/* Regular Properties */}
        {visibleProperties.map((prop) => (
          <div key={prop.name} className="flex items-center gap-1.5 text-xs">
            <span className="text-engineering-300 flex-shrink-0">•</span>
            <span className="font-mono text-engineering-600 truncate" title={prop.name}>
              {prop.name}
            </span>
            <span className="text-engineering-400 flex-shrink-0 text-[10px]">
              {prop.type.replace('Edm.', '')}
            </span>
          </div>
        ))}

        {/* More properties indicator */}
        {hiddenCount > 0 && (
          <div className="text-[10px] text-engineering-400 text-center pt-1">
            +{hiddenCount} more propert{hiddenCount === 1 ? 'y' : 'ies'}
          </div>
        )}

        {/* Empty state */}
        {entity.properties.length === 0 && (
          <div className="text-xs text-engineering-400 text-center py-1">No properties</div>
        )}

        {/* Navigation Properties indicator */}
        {entity.navigationProperties.length > 0 && (
          <div className="border-t border-engineering-100 mt-1 pt-1">
            <div className="flex items-center gap-1 text-[10px] text-primary-500">
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13 7l5 5m0 0l-5 5m5-5H6"
                />
              </svg>
              <span>
                {entity.navigationProperties.length} navigation propert
                {entity.navigationProperties.length === 1 ? 'y' : 'ies'}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Handles for connections */}
      <Handle
        type="target"
        position={Position.Top}
        className="!w-3 !h-3 !bg-primary-500 !border-2 !border-white"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className="!w-3 !h-3 !bg-primary-500 !border-2 !border-white"
      />
    </div>
  );
}

export const EntityNode = memo(EntityNodeComponent);
