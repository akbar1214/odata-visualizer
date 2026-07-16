import OpenAI from 'openai';
import type { ODataMetadata } from '@odata-visualizer/shared';

const BASE_URL = process.env['OPENAI_BASE_URL'] || 'http://localhost:4000/v1';
const API_KEY = process.env['OPENAI_API_KEY'] || 'sk-placeholder';
const MODEL = process.env['OPENAI_MODEL'] || 'gpt-4o';

const client = new OpenAI({
  baseURL: BASE_URL,
  apiKey: API_KEY,
});

function formatMetadataForLLM(metadata: ODataMetadata): string {
  const lines: string[] = [];
  lines.push('OData Metadata Schema:');
  lines.push('');
  lines.push(`Entities: ${metadata.entities.length}`);
  lines.push(`Relationships: ${metadata.relationships.length}`);
  lines.push('');

  for (const entity of metadata.entities) {
    lines.push(`Entity: ${entity.name}`);
    if (entity.namespace) lines.push(`  Namespace: ${entity.namespace}`);
    if (entity.keys.length > 0) lines.push(`  Keys: ${entity.keys.join(', ')}`);
    if (entity.baseType) lines.push(`  BaseType: ${entity.baseType}`);

    lines.push('  Properties:');
    for (const prop of entity.properties) {
      const nullable = prop.nullable ? '' : ' (non-nullable)';
      const key = prop.isKey ? ' [KEY]' : '';
      lines.push(`    - ${prop.name}: ${prop.type}${nullable}${key}`);
    }

    if (entity.navigationProperties.length > 0) {
      lines.push('  Navigation Properties:');
      for (const nav of entity.navigationProperties) {
        lines.push(`    - ${nav.name} -> ${nav.relationship}`);
      }
    }
    lines.push('');
  }

  if (metadata.relationships.length > 0) {
    lines.push('Relationships:');
    for (const rel of metadata.relationships) {
      lines.push(`  - ${rel.name}: ${rel.from.entity} (${rel.from.multiplicity}) <-> ${rel.to.entity} (${rel.to.multiplicity})`);
    }
  }

  return lines.join('\n');
}

export interface ChatResponse {
  response: string;
  query?: string;
}

export async function chat(
  metadata: ODataMetadata,
  userMessage: string
): Promise<ChatResponse> {
  const schemaContext = formatMetadataForLLM(metadata);

  const systemPrompt = `You are an OData query expert. You help users write OData queries based on the provided metadata schema.

When the user asks how to get data, generate the appropriate OData query URL path and query parameters.

Rules:
- Use OData v4 syntax
- Use $filter for filtering, $select for selecting fields, $expand for navigation properties, $orderby for sorting, $top/$skip for pagination
- Return the query as a relative URL path (e.g., /Products?$filter=Price gt 100)
- Explain the query briefly
- If the user asks about a specific entity, use get_entity_details tool to get its full schema first

Available entity names: ${metadata.entities.map((e) => e.name).join(', ')}

${schemaContext}`;

  const completion = await client.chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.3,
    max_tokens: 1024,
  });

  const content = completion.choices[0]?.message?.content || 'No response generated.';

  const queryMatch = content.match(/(?:GET\s+)?(\/\S+(?:\?\S+)?)/i);
  const query = queryMatch ? queryMatch[1] : undefined;

  return {
    response: content,
    query,
  };
}
