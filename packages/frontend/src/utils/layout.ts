import ELK from 'elkjs';
import type { ODataMetadata } from '@odata-visualizer/shared';
import type { Node, Edge } from '@xyflow/react';

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
  options: LayoutOptions = {}
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
function applyGridLayout(
  nodes: Node[],
  edges: Edge[]
): { nodes: Node[]; edges: Edge[] } {
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
 * Filter metadata based on criteria
 */
export function filterMetadata(
  metadata: ODataMetadata,
  filter: {
    search?: string;
    entityNames?: string[];
    maxEntities?: number;
  }
): ODataMetadata {
  let filteredEntities = [...metadata.entities];

  // Filter by search term
  if (filter.search) {
    const searchLower = filter.search.toLowerCase();
    filteredEntities = filteredEntities.filter(
      (entity) =>
        entity.name.toLowerCase().includes(searchLower) ||
        entity.label?.toLowerCase().includes(searchLower) ||
        entity.namespace?.toLowerCase().includes(searchLower)
    );
  }

  // Filter by specific entity names
  if (filter.entityNames && filter.entityNames.length > 0) {
    filteredEntities = filteredEntities.filter((entity) =>
      filter.entityNames!.includes(entity.name)
    );
  }

  // Limit number of entities
  if (filter.maxEntities && filteredEntities.length > filter.maxEntities) {
    filteredEntities = filteredEntities.slice(0, filter.maxEntities);
  }

  const filteredEntityNames = new Set(filteredEntities.map((e) => e.name));

  // Filter relationships to only include filtered entities
  const filteredRelationships = metadata.relationships.filter(
    (rel) =>
      filteredEntityNames.has(rel.from.entity) && filteredEntityNames.has(rel.to.entity)
  );

  return {
    ...metadata,
    entities: filteredEntities,
    relationships: filteredRelationships,
  };
}
