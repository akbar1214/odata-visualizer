import ELK from 'elkjs';
import type { ODataMetadata } from '@odata-visualizer/shared';
import {
  findPaths,
  getReachableEntities,
  isComposableEdge,
  type TraversalEdge,
  type TraversalPath,
  type TraversalStep,
} from '@odata-visualizer/shared';
import {
  getTargetEntityName,
  findEntity,
  type ExpandItem,
  type QueryFilter,
  type FilterLogic,
  type QueryState,
} from './queryResolver';

// The traversal lives in `shared` so the query builder, MCP and any other
// consumer walk one graph. Re-exported here for the components that already
// import the pathfinder from this module.
export { findPaths, getReachableEntities };
export type { TraversalEdge, TraversalPath, TraversalStep };

const elk = new ELK();

const NODE_WIDTH = 260;
const NODE_HEIGHT = 280;

export interface GraphNodeState {
  id: string;
  entityName: string;
  parentId: string | null;
  navProperty: string | null;
  /**
   * The edge that created this node. Carries the kind, so a bound function can
   * never be mistaken for a navigation property: `navProperty` stays null for
   * function steps and they are not written into `$expand`.
   */
  step: TraversalStep | null;
  select: string[];
  filters: QueryFilter[];
  filterLogic: FilterLogic;
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
  kind: TraversalEdge['kind'];
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
    step: null,
    select: [],
    filters: [],
    filterLogic: 'and',
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
  metadata: ODataMetadata,
): GraphState {
  const parentNode = state.nodes.find((n) => n.id === parentId);
  if (!parentNode) return state;

  const sourceEntity = findEntity(parentNode.entityName, metadata.entities);
  if (!sourceEntity) return state;

  const targetEntityName = getTargetEntityName(navProperty, sourceEntity, metadata);
  if (!targetEntityName) return state;

  const existingChild = state.nodes.find(
    (n) => n.parentId === parentId && n.navProperty === navProperty,
  );
  if (existingChild) return state;

  const nodeId = nextNodeId();

  const newNode: GraphNodeState = {
    id: nodeId,
    entityName: targetEntityName,
    parentId,
    navProperty,
    step: {
      from: parentNode.entityName,
      to: targetEntityName,
      edge: { kind: 'nav', name: navProperty, from: parentNode.entityName, to: targetEntityName },
    },
    select: [],
    filters: [],
    filterLogic: 'and',
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
    kind: 'nav',
  };

  return {
    nodes: newNodes,
    edges: [...state.edges, newEdge],
  };
}

export function removeExpandedNode(state: GraphState, nodeId: string): GraphState {
  const node = state.nodes.find((n) => n.id === nodeId);
  if (!node || node.id === 'root') return state;

  const idsToRemove = new Set<string>();
  const collectDescendants = (id: string) => {
    idsToRemove.add(id);
    state.nodes.filter((n) => n.parentId === id).forEach((n) => collectDescendants(n.id));
  };
  collectDescendants(nodeId);

  const updatedNodes = state.nodes
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
    (e) => !idsToRemove.has(e.source) && !idsToRemove.has(e.target),
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

/**
 * Can this path be rendered by the builder? Every edge must be composable
 * (a bound function with parameters has values the builder cannot collect),
 * and a function step must be the first hop: the builder composes a function
 * into the *resource path*, which it can only do at the root. A function
 * deeper in a path would have to be a segment of an `$expand`, which OData V4
 * does not express.
 */
export function isComposablePath(path: TraversalPath): boolean {
  return path.every(
    (step, index) =>
      isComposableEdge(step.edge) && (step.edge.kind !== 'boundFunction' || index === 0),
  );
}

export function graphToExpandItems(state: GraphState, nodeId: string): ExpandItem[] {
  // A bound-function step is a resource-path segment, not an expansion: it
  // must never reach `$expand`. The function segment is composed into the
  // resource path by `buildODataQuery` instead.
  const children = state.nodes.filter(
    (n) => n.parentId === nodeId && n.step?.edge.kind !== 'boundFunction',
  );
  return children.map((child) => ({
    navProperty: child.navProperty || '',
    select: child.select,
    expand: graphToExpandItems(state, child.id),
    filters: child.filters,
    filterLogic: child.filterLogic,
    sort: child.sort,
    sortDirection: child.sortDirection,
    top: child.top,
    skip: child.skip,
  }));
}

/**
 * Project a query graph onto the `QueryState` the shared builder consumes.
 *
 * A bound-function step changes the resource path: the query addresses the
 * function result, so the result node owns the query options and the function
 * name never reaches `$expand`. The root's own options are not representable
 * before the function (they would filter the source of the invocation, which a
 * URL cannot express), so they are not part of the query.
 */
export function graphToQueryState(state: GraphState, fallbackEntity: string): QueryState {
  const rootNode = state.nodes.find((n) => n.id === 'root');
  if (!rootNode) {
    return {
      entityName: fallbackEntity,
      filters: [],
      filterLogic: 'and',
      select: [],
      expand: [],
      sort: '',
      sortDirection: 'asc',
      top: 25,
      skip: 0,
    };
  }

  const functionNode = state.nodes.find(
    (n) => n.parentId === 'root' && n.step?.edge.kind === 'boundFunction',
  );
  const optionNode = functionNode ?? rootNode;
  const functionEdge = functionNode?.step?.edge;

  return {
    entityName: optionNode.entityName,
    sourceEntity: functionEdge ? rootNode.entityName : undefined,
    segment:
      functionEdge?.kind === 'boundFunction'
        ? {
            name: functionEdge.functionName,
            qualifiedName: functionEdge.qualifiedName,
            parameters: functionEdge.parameters,
            bindingIsCollection: functionEdge.bindingIsCollection,
            returnsCollection: functionEdge.returnsCollection,
          }
        : undefined,
    filters: optionNode.filters,
    filterLogic: optionNode.filterLogic,
    select: optionNode.select,
    expand: graphToExpandItems(state, optionNode.id),
    sort: optionNode.sort,
    sortDirection: optionNode.sortDirection,
    top: optionNode.top,
    skip: optionNode.skip,
  };
}

export function expandPath(sourceEntity: string, path: TraversalPath): GraphState {
  const nodes: GraphNodeState[] = [];
  const edges: GraphEdge[] = [];

  const rootNode = createRootNode(sourceEntity);
  nodes.push(rootNode);

  let parentId = 'root';

  for (const step of path) {
    const nodeId = nextNodeId();
    const navProperty = step.edge.kind === 'nav' ? step.edge.name : null;

    const newNode: GraphNodeState = {
      id: nodeId,
      entityName: step.to,
      parentId,
      navProperty,
      step,
      select: [],
      filters: [],
      filterLogic: 'and',
      sort: '',
      sortDirection: 'asc',
      top: 0,
      skip: 0,
      expandedNavProps: [],
      position: { x: 0, y: 0 },
    };

    nodes.push(newNode);

    const parentNode = nodes.find((n) => n.id === parentId);
    // Only navigation steps are expansions; a function step changes the
    // resource path and must not be recorded as an expanded nav property.
    if (parentNode && navProperty) {
      parentNode.expandedNavProps.push(navProperty);
    }

    edges.push({
      id: `edge-${parentId}-${nodeId}`,
      source: parentId,
      target: nodeId,
      label: step.edge.kind === 'nav' ? step.edge.name : `${step.edge.functionName}()`,
      kind: step.edge.kind,
    });

    parentId = nodeId;
  }

  return { nodes, edges };
}
