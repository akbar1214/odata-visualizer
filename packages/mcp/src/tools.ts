import type { ODataEntity, ODataMetadata, ODataRelationship } from '@odata-visualizer/shared';
import { loadMetadataFromSource, type MetadataSource } from './metadata-loader.js';

let currentMetadata: ODataMetadata | null = null;

export function getMetadata(): ODataMetadata | null {
  return currentMetadata;
}

export function resetMetadata(): void {
  currentMetadata = null;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function formatEntitySummary(entity: ODataEntity): string {
  const keyStr = entity.keys.length > 0 ? ` (keys: ${entity.keys.join(', ')})` : '';
  const propCount = entity.properties.length;
  const navCount = entity.navigationProperties.length;
  return `${entity.name}${keyStr} - ${propCount} properties, ${navCount} navigation properties`;
}

function formatEntityDetails(entity: ODataEntity): string {
  const lines: string[] = [];
  lines.push(`Entity: ${entity.name}`);
  if (entity.namespace) lines.push(`Namespace: ${entity.namespace}`);
  if (entity.baseType) lines.push(`Base Type: ${entity.baseType}`);
  if (entity.abstract) lines.push('Abstract: true');
  if (entity.openType) lines.push('Open Type: true');

  if (entity.keys.length > 0) {
    lines.push(`\nKeys: ${entity.keys.join(', ')}`);
  }

  if (entity.properties.length > 0) {
    lines.push('\nProperties:');
    for (const prop of entity.properties) {
      const nullable = prop.nullable ? '' : ' (non-nullable)';
      const key = prop.isKey ? ' [KEY]' : '';
      const maxLen = prop.maxLength ? ` (max: ${prop.maxLength})` : '';
      lines.push(`  - ${prop.name}: ${prop.type}${nullable}${key}${maxLen}`);
    }
  }

  if (entity.navigationProperties.length > 0) {
    lines.push('\nNavigation Properties:');
    for (const nav of entity.navigationProperties) {
      if (nav.targetType) {
        lines.push(`  - ${nav.name} -> ${nav.targetType}`);
      } else {
        lines.push(`  - ${nav.name} -> ${nav.relationship} (${nav.fromRole} -> ${nav.toRole})`);
      }
    }
  }

  return lines.join('\n');
}

function formatRelationship(rel: ODataRelationship): string {
  return `${rel.name}: ${rel.from.entity} (${rel.from.multiplicity}) <-> ${rel.to.entity} (${rel.to.multiplicity})`;
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  switch (name) {
    case 'load_metadata': {
      const source = args['source'] as string;
      const type = args['type'] as 'file' | 'url';

      if (!source) {
        return errorResult('Error: source is required');
      }

      try {
        const metadataSource: MetadataSource = { type, path: source };
        currentMetadata = await loadMetadataFromSource(metadataSource);

        const summary = [
          `Successfully loaded OData metadata from ${source}`,
          '',
          `Found ${currentMetadata.entities.length} entities and ${currentMetadata.relationships.length} relationships.`,
          '',
          'Entities:',
          ...currentMetadata.entities.map((e) => `  - ${formatEntitySummary(e)}`),
        ].join('\n');

        return { content: [{ type: 'text', text: summary }] };
      } catch (error) {
        return errorResult(
          `Error loading metadata: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    }

    case 'list_entities': {
      if (!currentMetadata) {
        return errorResult('No metadata loaded. Call load_metadata first with a file path or URL.');
      }

      if (currentMetadata.entities.length === 0) {
        return { content: [{ type: 'text', text: 'No entities found in the metadata.' }] };
      }

      const list = currentMetadata.entities.map((e) => formatEntitySummary(e)).join('\n');
      return {
        content: [
          {
            type: 'text',
            text: `Found ${currentMetadata.entities.length} entities:\n\n${list}`,
          },
        ],
      };
    }

    case 'get_entity_details': {
      if (!currentMetadata) {
        return errorResult('No metadata loaded. Call load_metadata first with a file path or URL.');
      }

      const entityName = args['entityName'] as string;
      if (!entityName) {
        return errorResult('Error: entityName is required');
      }

      const entity = currentMetadata.entities.find(
        (e) => e.name.toLowerCase() === entityName.toLowerCase(),
      );

      if (!entity) {
        const available = currentMetadata.entities.map((e) => e.name).join(', ');
        return errorResult(`Entity "${entityName}" not found. Available entities: ${available}`);
      }

      return {
        content: [{ type: 'text', text: formatEntityDetails(entity) }],
      };
    }

    case 'get_relationships': {
      if (!currentMetadata) {
        return errorResult('No metadata loaded. Call load_metadata first with a file path or URL.');
      }

      if (currentMetadata.relationships.length === 0) {
        return { content: [{ type: 'text', text: 'No relationships found in the metadata.' }] };
      }

      const rels = currentMetadata.relationships.map((r) => formatRelationship(r)).join('\n');
      return {
        content: [
          {
            type: 'text',
            text: `Found ${currentMetadata.relationships.length} relationships:\n\n${rels}`,
          },
        ],
      };
    }

    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}
