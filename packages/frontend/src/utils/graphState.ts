import ELK from 'elkjs';
import type { ODataMetadata, ODataEntity } from '@odata-visualizer/shared';
import {
  getTargetEntityName,
  findEntity,
  getResolvedNavProperties,
  type QueryFilter,
} from './queryResolver';

const elk = new ELK();

const NODE_WIDTH = 260;
const NODE_HEIGHT = 280;

export interface GraphNodeState {
  id: string;
  entityName: string;
  parentId: string | null;
  navProperty: string | null;
  select: string[];
  filters: QueryFilter[];
  sort: string;
  sortDirection: 'asc' | 'desc';
  top: number;
  skip: number;
  expandedNavProps: string[];
  position: { x: number; y: number };
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
}

export interface GraphState {
  nodes: GraphNodeState[];
  edges: GraphEdge[];
}

let nodeIdCounter = 0;
function nextNodeId(): string {
  return `node-${++nodeIdCounter}`;
}

export function createRootNode(entityName: string): GraphNodeState {
  return {
    id: 'root',
    entityName,
    parentId: null,
    navProperty: null,
    select: [],
    filters: [],
    sort: '',
    sortDirection: 'asc',
    top: 25,
    skip: 0,
    expandedNavProps: [],
    position: { x: 0, y: 0 },
  };
}

export function addExpandedNode(
  state: GraphState,
  parentId: string,
  navProperty: string,
  metadata: ODataMetadata
): GraphState {
  const parentNode = state.nodes.find((n) => n.id === parentId);
  if (!parentNode) return state;

  const sourceEntity = findEntity(parentNode.entityName, metadata.entities);
  if (!sourceEntity) return state;

  const targetEntityName = getTargetEntityName(navProperty, sourceEntity, metadata);
  if (!targetEntityName) return state;

  const existingChild = state.nodes.find(
    (n) => n.parentId === parentId && n.navProperty === navProperty
  );
  if (existingChild) return state;

  const nodeId = nextNodeId();

  const newNode: GraphNodeState = {
    id: nodeId,
    entityName: targetEntityName,
    parentId,
    navProperty,
    select: [],
    filters: [],
    sort: '',
    sortDirection: 'asc',
    top: 0,
    skip: 0,
    expandedNavProps: [],
    position: { x: 0, y: 0 },
  };

  const updatedParent = {
    ...parentNode,
    expandedNavProps: [...parentNode.expandedNavProps, navProperty],
  };

  const newNodes = state.nodes.map((n) => (n.id === parentId ? updatedParent : n));
  newNodes.push(newNode);

  const newEdge: GraphEdge = {
    id: `edge-${parentId}-${nodeId}`,
    source: parentId,
    target: nodeId,
    label: navProperty,
  };

  return {
    nodes: newNodes,
    edges: [...state.edges, newEdge],
  };
}

export function removeExpandedNode(
  state: GraphState,
  nodeId: string
): GraphState {
  const node = state.nodes.find((n) => n.id === nodeId);
  if (!node || node.id === 'root') return state;

  const idsToRemove = new Set<string>();
  const collectDescendants = (id: string) => {
    idsToRemove.add(id);
    state.nodes.filter((n) => n.parentId === id).forEach((n) => collectDescendants(n.id));
  };
  collectDescendants(nodeId);

  let updatedNodes = state.nodes
    .filter((n) => !idsToRemove.has(n.id))
    .map((n) => {
      if (n.id === node.parentId && node.navProperty) {
        return {
          ...n,
          expandedNavProps: n.expandedNavProps.filter((p) => p !== node.navProperty),
        };
      }
      return n;
    });

  const updatedEdges = state.edges.filter(
    (e) => !idsToRemove.has(e.source) && !idsToRemove.has(e.target)
  );

  return { nodes: updatedNodes, edges: updatedEdges };
}

export async function layoutGraph(state: GraphState): Promise<GraphState> {
  if (state.nodes.length <= 1) return state;

  const elkGraph = {
    id: 'root',
    layoutOptions: {
      'elk.direction': 'TB',
      'elk.spacing': '60',
      'elk.spacing.nodeNode': '40',
      'elk.layered.spacing.nodeNodeBetweenLayers': '80',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.nodePlacement': 'BRANDES_KOEPF',
    },
    children: state.nodes.map((n) => ({
      id: n.id,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    })),
    edges: state.edges.map((e) => ({
      id: e.id,
      sources: [e.source],
      targets: [e.target],
    })),
  };

  try {
    const layouted = await elk.layout(elkGraph);
    const posMap = new Map<string, { x: number; y: number }>();

    if (layouted.children) {
      for (const child of layouted.children) {
        if (child.x !== undefined && child.y !== undefined) {
          posMap.set(child.id, { x: child.x, y: child.y });
        }
      }
    }

    return {
      ...state,
      nodes: state.nodes.map((n) => ({
        ...n,
        position: posMap.get(n.id) || n.position,
      })),
    };
  } catch {
    return state;
  }
}

export function getReachableEntities(
  entityName: string,
  metadata: ODataMetadata,
  maxDepth: number = 4
): Map<string, { entity: ODataEntity; navProp: string; parentEntity: string }[]> {
  const result = new Map<string, { entity: ODataEntity; navProp: string; parentEntity: string }[]>();
  const visited = new Set<string>();

  const bfs = (startEntityName: string) => {
    const queue: { entityName: string; depth: number }[] = [{ entityName: startEntityName, depth: 0 }];
    visited.add(startEntityName.toLowerCase());

    while (queue.length > 0) {
      const { entityName: currentName, depth: currentDepth } = queue.shift()!;
      if (currentDepth >= maxDepth) continue;

      const entity = findEntity(currentName, metadata.entities);
      if (!entity) continue;

      const navProps = getResolvedNavProperties(entity, metadata.entities);
      const targets: { entity: ODataEntity; navProp: string; parentEntity: string }[] = [];

      for (const nav of navProps) {
        const targetName = getTargetEntityName(nav.name, entity, metadata);
        if (!targetName) continue;

        const targetEntity = findEntity(targetName, metadata.entities);
        if (!targetEntity) continue;

        targets.push({ entity: targetEntity, navProp: nav.name, parentEntity: currentName });

        const key = `${currentName.toLowerCase()}-${targetName.toLowerCase()}`;
        if (!visited.has(key)) {
          visited.add(key);
          queue.push({ entityName: targetName, depth: currentDepth + 1 });
        }
      }

      if (targets.length > 0) {
        const existing = result.get(currentName) || [];
        result.set(currentName, [...existing, ...targets]);
      }
    }
  };

  bfs(entityName);
  return result;
}

export function graphToExpandItems(
  state: GraphState,
  nodeId: string,
): import('./queryResolver').ExpandItem[] {
  const children = state.nodes.filter((n) => n.parentId === nodeId);
  return children.map((child) => ({
    navProperty: child.navProperty || '',
    select: child.select,
    expand: graphToExpandItems(state, child.id),
    filters: child.filters,
    sort: child.sort,
    sortDirection: child.sortDirection,
    top: child.top,
    skip: child.skip,
  }));
}
