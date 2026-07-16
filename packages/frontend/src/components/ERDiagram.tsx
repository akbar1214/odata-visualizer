import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  BackgroundVariant,
  type OnNodesChange,
  type ReactFlowInstance,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { ODataMetadata } from '@odata-visualizer/shared';
import { EntityNode } from './EntityNode';
import { RelationshipEdge } from './RelationshipEdge';
import { layoutDiagram, filterMetadata } from '../utils/layout';

const nodeTypes = {
  entity: EntityNode,
};

const edgeTypes = {
  relationship: RelationshipEdge,
};

interface ERDiagramProps {
  metadata: ODataMetadata;
  selectedEntity?: string | null;
  onEntitySelect?: (entityName: string | null) => void;
}

export function ERDiagram({ metadata, selectedEntity, onEntitySelect }: ERDiagramProps) {
  const initialNodes: Node[] = [];
  const initialEdges: Edge[] = [];
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [loading, setLoading] = useState(true);
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null);

  // Layout diagram when metadata changes
  useEffect(() => {
    let cancelled = false;

    async function layout() {
      setLoading(true);
      try {
        // For large models, limit initial display
        const maxInitialEntities = 100;
        let metadataToLayout = metadata;

        if (metadata.entities.length > maxInitialEntities) {
          metadataToLayout = filterMetadata(metadata, { maxEntities: maxInitialEntities });
        }

        const { nodes: layoutedNodes, edges: layoutedEdges } =
          await layoutDiagram(metadataToLayout);

        if (!cancelled) {
          setNodes(layoutedNodes);
          setEdges(layoutedEdges);
        }
      } catch (error) {
        console.error('Layout error:', error);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    layout();

    return () => {
      cancelled = true;
    };
  }, [metadata, setNodes, setEdges]);

  // Handle node selection
  const handleNodesChange: OnNodesChange = useCallback(
    (changes) => {
      onNodesChange(changes);

      // Handle selection changes
      for (const change of changes) {
        if (change.type === 'select' && change.selected) {
          const node = nodes.find((n) => n.id === change.id);
          if (node) {
            onEntitySelect?.(node.id);
          }
        }
      }
    },
    [onNodesChange, nodes, onEntitySelect],
  );

  // Fit view when nodes change
  useEffect(() => {
    if (reactFlowInstance && nodes.length > 0 && !loading) {
      setTimeout(() => {
        reactFlowInstance.fitView({ padding: 0.2, maxZoom: 1.5 });
      }, 100);
    }
  }, [reactFlowInstance, nodes.length, loading]);

  // Highlight selected entity
  const highlightedNodes = useMemo(() => {
    return nodes.map((node) => ({
      ...node,
      selected: node.id === selectedEntity,
    }));
  }, [nodes, selectedEntity]);

  if (loading) {
    return (
      <div className="w-full h-[600px] border border-engineering-200 rounded bg-engineering-100 flex items-center justify-center">
        <div className="text-center">
          <svg
            className="animate-spin h-10 w-10 text-primary-500 mx-auto mb-4"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
          <p className="text-engineering-600">Layouting diagram...</p>
          <p className="text-sm text-engineering-400 mt-1">
            Processing {metadata.entities.length} entities
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full h-[600px] border border-engineering-200 rounded bg-white">
      <ReactFlow
        nodes={highlightedNodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        onEdgesChange={onEdgesChange}
        onInit={setReactFlowInstance}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.1}
        maxZoom={3}
        defaultEdgeOptions={{
          type: 'relationship',
        }}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <Controls position="bottom-left" showInteractive={false} />
        <MiniMap
          nodeColor={(node) => {
            if (node.id === selectedEntity) return '#0A8276';
            return '#EEEDED';
          }}
          maskColor="rgba(0, 0, 0, 0.1)"
          position="bottom-right"
        />
      </ReactFlow>
    </div>
  );
}
