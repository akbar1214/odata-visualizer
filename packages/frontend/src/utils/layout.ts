import ELK from 'elkjs';
import type { ODataEntity, ODataMetadata, ODataRelationship } from '@odata-visualizer/shared';
import type { Node, Edge } from '@xyflow/react';
import { createEntitySearch } from './entitySearch';

const elk = new ELK();

const NODE_WIDTH = 240;
const NODE_HEIGHT = 180;

/**
 * Diagram id for a type.
 *
 * Qualified names are unique within a model; short names are not. The Windchill
 * fixture ships `PTC.ProdMgmt.Part` and `net.example.common.Part`, and keying
 * nodes on the short name made one of them disappear from the diagram entirely
 * (React Flow and ELK both treat the duplicate id as one item).
 */
export function entityNodeId(entity: ODataEntity): string {
  return entity.qualifiedName ?? entity.name;
}

interface EndpointIndex {
  /** Lowercased qualified or short name of a type that exists on the diagram. */
  byId: Map<string, string>;
  /** Lowercased short name to every node carrying it. */
  byShort: Map<string, Array<{ id: string; namespace?: string }>>;
}

function buildEndpointIndex(entities: ODataEntity[]): EndpointIndex {
  const byId = new Map<string, string>();
  const byShort = new Map<string, Array<{ id: string; namespace?: string }>>();

  for (const entity of entities) {
    const id = entityNodeId(entity);
    byId.set(id.toLowerCase(), id);
    const key = entity.name.toLowerCase();
    const candidates = byShort.get(key) ?? [];
    candidates.push({ id, namespace: entity.namespace });
    byShort.set(key, candidates);
  }

  return { byId, byShort };
}

/**
 * Map a relationship endpoint to a diagram node id.
 *
 * Relationships record the *short* type name, which is not unique across
 * namespaces, so an ambiguous one is resolved against the namespace that
 * declared the relationship. Returning `undefined` rather than guessing keeps a
 * bad match from drawing an edge between the wrong pair of types.
 */
function resolveEndpoint(
  index: EndpointIndex,
  name: string,
  namespace: string | undefined,
): string | undefined {
  const direct = index.byId.get(name.toLowerCase());
  if (direct) return direct;

  const candidates = index.byShort.get(name.toLowerCase());
  if (!candidates || candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0].id;

  return candidates.find((candidate) => candidate.namespace === namespace)?.id;
}

/**
 * Diagram edge id.
 *
 * `${from}-${to}` collided for every relationship between the same pair of
 * types, so parallel associations (`BillingAddress` / `ShippingAddress`) and
 * same-target navigation properties collapsed into one edge. The relationship's
 * own name is unique per navigation property; the index guarantees uniqueness
 * even if a model somehow repeats one.
 */
function edgeId(relationship: ODataRelationship, index: number): string {
  const base = relationship.namespace
    ? `${relationship.namespace}.${relationship.name}`
    : relationship.name;
  return `${base}#${index}`;
}

interface LayoutOptions {
  direction?: 'TB' | 'LR' | 'BT' | 'RL';
  spacing?: number;
  nodeSpacing?: number;
}

/**
 * Convert OData metadata to React Flow nodes and edges with automatic layout
 */
export async function layoutDiagram(
  metadata: ODataMetadata,
  options: LayoutOptions = {},
): Promise<{ nodes: Node[]; edges: Edge[] }> {
  const { direction = 'TB', spacing = 80, nodeSpacing = 50 } = options;

  const endpoints = buildEndpointIndex(metadata.entities);

  // Create nodes from entities
  const nodes: Node[] = metadata.entities.map((entity) => ({
    id: entityNodeId(entity),
    type: 'entity',
    position: { x: 0, y: 0 },
    data: { entity },
  }));

  // Create edges from relationships, dropping any whose endpoints cannot be
  // resolved to a node (an ambiguous short name with no namespace match).
  const resolvedEdges = metadata.relationships
    .map((rel, position) => {
      const source = resolveEndpoint(endpoints, rel.from.entity, rel.namespace);
      const target = resolveEndpoint(endpoints, rel.to.entity, rel.namespace);
      return source && target ? { rel, source, target, id: edgeId(rel, position) } : undefined;
    })
    .filter((edge): edge is NonNullable<typeof edge> => edge !== undefined);

  const edges: Edge[] = resolvedEdges.map(({ rel, source, target, id }) => ({
    id,
    source,
    target,
    type: 'relationship',
    data: { relationship: rel },
  }));

  // Build ELK graph
  const elkGraph = {
    id: 'root',
    layoutOptions: {
      'elk.direction': direction,
      'elk.spacing': String(spacing),
      'elk.spacing.nodeNode': String(nodeSpacing),
      'elk.layered.spacing.nodeNodeBetweenLayers': String(spacing),
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.nodePlacement': 'BRANDES_KOEPF',
    },
    children: nodes.map((node) => ({
      id: node.id,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    })),
    edges: resolvedEdges.map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
    })),
  };

  try {
    const layoutedGraph = await elk.layout(elkGraph);

    // Apply layout positions to nodes
    if (layoutedGraph.children) {
      for (const child of layoutedGraph.children) {
        const node = nodes.find((n) => n.id === child.id);
        if (node && child.x !== undefined && child.y !== undefined) {
          node.position = { x: child.x, y: child.y };
        }
      }
    }

    return { nodes, edges };
  } catch (error) {
    console.error('Layout failed:', error);
    // Return with manual grid layout as fallback
    return applyGridLayout(nodes, edges);
  }
}

/**
 * Apply a simple grid layout as fallback
 */
function applyGridLayout(nodes: Node[], edges: Edge[]): { nodes: Node[]; edges: Edge[] } {
  const columns = Math.ceil(Math.sqrt(nodes.length));
  const spacingX = NODE_WIDTH + 100;
  const spacingY = NODE_HEIGHT + 100;

  nodes.forEach((node, index) => {
    const row = Math.floor(index / columns);
    const col = index % columns;
    node.position = {
      x: col * spacingX,
      y: row * spacingY,
    };
  });

  return { nodes, edges };
}

/**
 * Filter metadata based on criteria.
 *
 * A text search ranks matches by relevance and keeps one-hop neighbours of the
 * matches, so searching for a type still shows the relationships around it
 * instead of a set of disconnected nodes.
 */
export function filterMetadata(
  metadata: ODataMetadata,
  filter: {
    search?: string;
    entityNames?: string[];
    maxEntities?: number;
    includeComplexTypes?: boolean;
    /** Keep entities directly related to a match (default true when searching). */
    includeNeighbours?: boolean;
  },
): ODataMetadata {
  const search = createEntitySearch(metadata);
  const query = (filter.search ?? '').trim();

  // No text search: behave like the unfiltered model (this is how the diagram
  // loads a whole model), then apply the remaining criteria.
  let filteredEntities = query
    ? search(query, { includeComplexTypes: filter.includeComplexTypes ?? false }).map(
        (match) => match.entity,
      )
    : [...metadata.entities];

  // Filter by specific entity names (short or namespace-qualified).
  if (filter.entityNames && filter.entityNames.length > 0) {
    const wanted = new Set(filter.entityNames);
    filteredEntities = filteredEntities.filter(
      (entity) => wanted.has(entity.name) || wanted.has(entity.qualifiedName ?? ''),
    );
  }

  if (query && (filter.includeNeighbours ?? true)) {
    // Expand exactly one hop from the *original* matches. Mutating a single
    // set while iterating would cascade and pull in the whole model.
    const endpoints = buildEndpointIndex(metadata.entities);
    const seeds = new Set(filteredEntities.map(entityNodeId));
    const selected = new Set(seeds);
    for (const rel of metadata.relationships) {
      const source = resolveEndpoint(endpoints, rel.from.entity, rel.namespace);
      const target = resolveEndpoint(endpoints, rel.to.entity, rel.namespace);
      if (!source || !target) continue;
      if (seeds.has(source) && !seeds.has(target)) selected.add(target);
      if (seeds.has(target) && !seeds.has(source)) selected.add(source);
    }

    // Keep the ranked order: real matches stay in score order and neighbours
    // follow, so maxEntities below keeps the best matches rather than whatever
    // happens to come first in the original metadata.
    const rank = new Map(
      filteredEntities.map((entity, position) => [entityNodeId(entity), position]),
    );
    filteredEntities = metadata.entities
      .filter((entity) => selected.has(entityNodeId(entity)))
      .sort(
        (a, b) =>
          (rank.get(entityNodeId(a)) ?? Number.MAX_SAFE_INTEGER) -
          (rank.get(entityNodeId(b)) ?? Number.MAX_SAFE_INTEGER),
      );
  }

  // Limit last, so relevance decides what survives.
  if (filter.maxEntities && filteredEntities.length > filter.maxEntities) {
    filteredEntities = filteredEntities.slice(0, filter.maxEntities);
  }

  const endpoints = buildEndpointIndex(filteredEntities);
  const keptIds = new Set(filteredEntities.map(entityNodeId));

  // Keep relationships that still have both endpoints on the diagram.
  const filteredRelationships = metadata.relationships.filter((rel) => {
    const source = resolveEndpoint(endpoints, rel.from.entity, rel.namespace);
    const target = resolveEndpoint(endpoints, rel.to.entity, rel.namespace);
    return (
      source !== undefined && target !== undefined && keptIds.has(source) && keptIds.has(target)
    );
  });

  return {
    ...metadata,
    entities: filteredEntities,
    relationships: filteredRelationships,
  };
}
