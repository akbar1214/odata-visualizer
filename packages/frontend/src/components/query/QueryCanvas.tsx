import { useCallback, useMemo, useRef, useEffect } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  useReactFlow,
  type Node,
  type Edge,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { ODataMetadata } from '@odata-visualizer/shared';
import type { GraphNodeState, GraphEdge } from '../../utils/graphState';
import { addExpandedNode, removeExpandedNode, layoutGraph } from '../../utils/graphState';
import { GraphNode, type GraphNodeData } from './GraphNode';

interface QueryCanvasProps {
  graphNodes: GraphNodeState[];
  graphEdges: GraphEdge[];
  metadata: ODataMetadata;
  onGraphChange: (nodes: GraphNodeState[], edges: GraphEdge[]) => void;
}

const nodeTypes: NodeTypes = {
  entityNode: GraphNode as NodeTypes['entityNode'],
};

function QueryCanvasInner({
  graphNodes,
  graphEdges,
  metadata,
  onGraphChange,
}: QueryCanvasProps) {
  const { fitView } = useReactFlow();
  const prevCountRef = useRef(graphNodes.length);

  useEffect(() => {
    if (graphNodes.length !== prevCountRef.current) {
      prevCountRef.current = graphNodes.length;
      const timer = setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 50);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [graphNodes.length, fitView]);

  const doLayoutAndChange = useCallback(
    async (newState: { nodes: GraphNodeState[]; edges: GraphEdge[] }) => {
      const laid = await layoutGraph(newState);
      onGraphChange(laid.nodes, laid.edges);
    },
    [onGraphChange]
  );

  const handleExpandNav = useCallback(
    (nodeId: string, navProp: string) => {
      const state = { nodes: graphNodes, edges: graphEdges };
      const newState = addExpandedNode(state, nodeId, navProp, metadata);
      if (newState !== state) {
        doLayoutAndChange(newState);
      }
    },
    [graphNodes, graphEdges, metadata, doLayoutAndChange]
  );

  const handleRemove = useCallback(
    (nodeId: string) => {
      const state = { nodes: graphNodes, edges: graphEdges };
      const newState = removeExpandedNode(state, nodeId);
      if (newState !== state) {
        doLayoutAndChange(newState);
      }
    },
    [graphNodes, graphEdges, doLayoutAndChange]
  );

  const handleSelectToggle = useCallback(
    (nodeId: string, propName: string) => {
      const node = graphNodes.find((n) => n.id === nodeId);
      if (!node) return;
      const newSelect = node.select.includes(propName)
        ? node.select.filter((s) => s !== propName)
        : [...node.select, propName];
      onGraphChange(
        graphNodes.map((n) => (n.id === nodeId ? { ...n, select: newSelect } : n)),
        graphEdges
      );
    },
    [graphNodes, graphEdges, onGraphChange]
  );

  const handleFilterAdd = useCallback(
    (nodeId: string) => {
      const node = graphNodes.find((n) => n.id === nodeId);
      if (!node) return;
      const resolved = metadata.entities.find((e) => e.name === node.entityName);
      if (!resolved || resolved.properties.length === 0) return;
      const prop = resolved.properties[0];
      onGraphChange(
        graphNodes.map((n) =>
          n.id === nodeId
            ? { ...n, filters: [...n.filters, { property: prop.name, operator: 'eq', value: '' }] }
            : n
        ),
        graphEdges
      );
    },
    [graphNodes, graphEdges, metadata, onGraphChange]
  );

  const handleFilterRemove = useCallback(
    (nodeId: string, index: number) => {
      onGraphChange(
        graphNodes.map((n) =>
          n.id === nodeId
            ? { ...n, filters: n.filters.filter((_, i) => i !== index) }
            : n
        ),
        graphEdges
      );
    },
    [graphNodes, graphEdges, onGraphChange]
  );

  const handleFilterUpdate = useCallback(
    (nodeId: string, index: number, field: string, value: string) => {
      onGraphChange(
        graphNodes.map((n) =>
          n.id === nodeId
            ? {
                ...n,
                filters: n.filters.map((f, i) =>
                  i === index ? { ...f, [field]: value } : f
                ),
              }
            : n
        ),
        graphEdges
      );
    },
    [graphNodes, graphEdges, onGraphChange]
  );

  const handleSortChange = useCallback(
    (nodeId: string, sort: string) => {
      onGraphChange(
        graphNodes.map((n) => (n.id === nodeId ? { ...n, sort } : n)),
        graphEdges
      );
    },
    [graphNodes, graphEdges, onGraphChange]
  );

  const handleSortDirectionChange = useCallback(
    (nodeId: string, dir: 'asc' | 'desc') => {
      onGraphChange(
        graphNodes.map((n) => (n.id === nodeId ? { ...n, sortDirection: dir } : n)),
        graphEdges
      );
    },
    [graphNodes, graphEdges, onGraphChange]
  );

  const handleTopChange = useCallback(
    (nodeId: string, top: number) => {
      onGraphChange(
        graphNodes.map((n) => (n.id === nodeId ? { ...n, top } : n)),
        graphEdges
      );
    },
    [graphNodes, graphEdges, onGraphChange]
  );

  const handleSkipChange = useCallback(
    (nodeId: string, skip: number) => {
      onGraphChange(
        graphNodes.map((n) => (n.id === nodeId ? { ...n, skip } : n)),
        graphEdges
      );
    },
    [graphNodes, graphEdges, onGraphChange]
  );

  const flowNodes: Node[] = useMemo(
    () =>
      graphNodes.map((gn) => ({
        id: gn.id,
        type: 'entityNode',
        position: gn.position,
        data: {
          nodeState: gn,
          metadata,
          isRoot: gn.id === 'root',
          onSelectToggle: handleSelectToggle,
          onFilterAdd: handleFilterAdd,
          onFilterRemove: handleFilterRemove,
          onFilterUpdate: handleFilterUpdate,
          onSortChange: handleSortChange,
          onSortDirectionChange: handleSortDirectionChange,
          onTopChange: handleTopChange,
          onSkipChange: handleSkipChange,
          onExpandNav: handleExpandNav,
          onRemove: handleRemove,
        } satisfies GraphNodeData,
      })),
    [graphNodes, metadata, handleSelectToggle, handleFilterAdd, handleFilterRemove, handleFilterUpdate, handleSortChange, handleSortDirectionChange, handleTopChange, handleSkipChange, handleExpandNav, handleRemove]
  );

  const flowEdges: Edge[] = useMemo(
    () =>
      graphEdges.map((ge) => ({
        id: ge.id,
        source: ge.source,
        target: ge.target,
        label: ge.label,
        type: 'smoothstep',
        animated: true,
        labelStyle: { fontSize: 10 },
      })),
    [graphEdges]
  );

  if (graphNodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400 text-sm">
        Select an entity to start building a query
      </div>
    );
  }

  return (
    <div className="h-full w-full">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={true}
        nodesConnectable={false}
        elementsSelectable={false}
        defaultEdgeOptions={{ type: 'smoothstep', animated: true }}
      >
        <Background gap={20} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

export function QueryCanvas(props: QueryCanvasProps) {
  return (
    <ReactFlowProvider>
      <QueryCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
