import { memo } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
  type Edge,
} from '@xyflow/react';
import type { ODataRelationship } from '@odata-visualizer/shared';

export type RelationshipEdgeData = Edge<{
  relationship: ODataRelationship;
  label?: string;
}>;

function getMultiplicitySymbol(multiplicity: string): string {
  switch (multiplicity) {
    case '1':
      return '1';
    case '*':
      return '*';
    case '0..1':
      return '0..1';
    case '0..*':
      return '0..*';
    case '1..*':
      return '1..*';
    default:
      return multiplicity;
  }
}

function RelationshipEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
  style,
}: EdgeProps<RelationshipEdgeData>) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const relationship = data?.relationship;
  const fromMultiplicity = relationship
    ? getMultiplicitySymbol(relationship.from.multiplicity)
    : '';
  const toMultiplicity = relationship ? getMultiplicitySymbol(relationship.to.multiplicity) : '';

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          stroke: '#8D8786',
          strokeWidth: 2,
        }}
      />
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            pointerEvents: 'all',
          }}
          className="nodrag nopan"
        >
          {/* Multiplicity labels */}
          <div className="flex items-center gap-2 bg-white px-2 py-0.5 rounded shadow-odv border border-engineering-200">
            <span className="text-[10px] font-mono text-primary-500 font-medium">
              {fromMultiplicity}
            </span>
            <span className="text-[10px] text-engineering-400">—</span>
            <span className="text-[10px] font-mono text-primary-500 font-medium">
              {toMultiplicity}
            </span>
          </div>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

export const RelationshipEdge = memo(RelationshipEdgeComponent);
