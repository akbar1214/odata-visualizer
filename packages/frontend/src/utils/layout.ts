import ELK from 'elkjs';
import type { ODataMetadata } from '@odata-visualizer/shared';
import type { Node, Edge } from '@xyflow/react';
import { createEntitySearch } from './entitySearch';

const elk = new ELK();

const NODE_WIDTH = 240;
const NODE_HEIGHT = 180;

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

  // Create nodes from entities
  const nodes: Node[] = metadata.entities.map((entity) => ({
    id: entity.name,
    type: 'entity',
    position: { x: 0, y: 0 },
    data: { entity },
  }));

  // Create edges from relationships
  const edges: Edge[] = metadata.relationships.map((rel) => ({
    id: `${rel.from.entity}-${rel.to.entity}`,
    source: rel.from.entity,
    target: rel.to.entity,
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
    children: metadata.entities.map((entity) => ({
      id: entity.name,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    })),
    edges: metadata.relationships.map((rel) => ({
      id: `${rel.from.entity}-${rel.to.entity}`,
      sources: [rel.from.entity],
      targets: [rel.to.entity],
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
    const seeds = new Set(filteredEntities.map((entity) => entity.name));
    const selected = new Set(seeds);
    for (const rel of metadata.relationships) {
      if (seeds.has(rel.from.entity) && !seeds.has(rel.to.entity)) {
        selected.add(rel.to.entity);
      }
      if (seeds.has(rel.to.entity) && !seeds.has(rel.from.entity)) {
        selected.add(rel.from.entity);
      }
    }
    filteredEntities = metadata.entities.filter((entity) => selected.has(entity.name));
  }

  // Limit last, so relevance decides what survives.
  if (filter.maxEntities && filteredEntities.length > filter.maxEntities) {
    filteredEntities = filteredEntities.slice(0, filter.maxEntities);
  }

  const keptEntityNames = new Set(filteredEntities.map((entity) => entity.name));

  // Keep relationships that still have both endpoints on the diagram.
  const filteredRelationships = metadata.relationships.filter(
    (rel) => keptEntityNames.has(rel.from.entity) && keptEntityNames.has(rel.to.entity),
  );

  return {
    ...metadata,
    entities: filteredEntities,
    relationships: filteredRelationships,
  };
}
