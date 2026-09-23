import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ExpandNode } from '@odata-visualizer/shared';
import { createToolHandler, type ToolHandlerOptions } from './tools.js';
import type { MetadataAccessors } from './store.js';

export type {
  MetadataAccessors,
  MetadataInfo,
  MetadataSourceType,
  StoredMetadata,
} from './store.js';
export { createMetadataStore } from './store.js';

export interface McpServerOptions extends ToolHandlerOptions {
  name?: string;
  version?: string;
}

/**
 * Build an MCP server bound to a metadata store. The store can be shared
 * with another process (e.g. the backend), so uploaded metadata is used
 * automatically without a load_metadata call.
 */
export function createMcpServer(
  accessors: MetadataAccessors,
  options: McpServerOptions = {},
): McpServer {
  const server = new McpServer({
    name: options.name ?? 'odata-visualizer',
    version: options.version ?? '1.0.0',
  });

  const handleToolCall = createToolHandler(accessors, {
    allowLoadMetadata: options.allowLoadMetadata,
  });

  const filterSchema = z.object({
    property: z.string().describe('Property name to compare'),
    operator: z
      .enum(['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'contains', 'startswith', 'endswith', 'in'])
      .describe(
        'Comparison operator. String functions contain their argument differently; "in" takes a raw list.',
      ),
    value: z
      .string()
      .describe('Raw value; typed as an OData V4 literal from the model when metadata is loaded'),
  });

  const expandNodeSchema: z.ZodType<ExpandNode> = z.lazy(() =>
    z.object({
      navProperty: z.string().describe('Navigation property name'),
      select: z.array(z.string()).optional(),
      filters: z.array(filterSchema).optional(),
      filterLogic: z.enum(['and', 'or']).optional(),
      orderBy: z.string().optional().describe('e.g. "Name desc"'),
      top: z.number().int().nonnegative().optional(),
      skip: z.number().int().nonnegative().optional(),
      expand: z.array(expandNodeSchema).optional(),
    }),
  );

  const paginationSchema = {
    limit: z.number().int().positive().optional().describe('Max results (default 50)'),
    offset: z.number().int().nonnegative().optional().describe('Results to skip (default 0)'),
  };

  // The HTTP server shares metadata with the backend, so it does not expose
  // load_metadata (which would allow arbitrary file reads / SSRF).
  if (options.allowLoadMetadata !== false) {
    server.registerTool(
      'load_metadata',
      {
        description:
          'Load OData V4 metadata from a file path, a URL, or the OData Visualizer backend ("server", using the file uploaded in the UI). Call this only to override what the server already holds.',
        inputSchema: {
          source: z
            .string()
            .optional()
            .describe(
              'File path (e.g., "./metadata.xml"), URL (e.g., "https://host/Windchill/servlet/odata/ProdMgmt/$metadata"), or backend base URL. Omit for the default backend.',
            ),
          type: z
            .enum(['file', 'url', 'server'])
            .describe(
              '"file" (local path), "url" (remote $metadata), or "server" (metadata uploaded in the UI)',
            ),
        },
      },
      async (args) => handleToolCall('load_metadata', args),
    );
  }

  server.registerTool(
    'get_metadata_status',
    {
      description:
        'Show what metadata is currently loaded (source, when, and entity/set/action counts). Use this to confirm whether the file uploaded in the UI is available.',
      inputSchema: {},
    },
    async (args) => handleToolCall('get_metadata_status', args),
  );

  server.registerTool(
    'search_entities',
    {
      description:
        'Search entity and complex types by name, qualified name, label, property name, or annotation text. Best starting point when you know a keyword but not the exact type.',
      inputSchema: {
        query: z.string().describe('Search text, e.g. "part" or "wt.part.WTPart"'),
        limit: z.number().int().positive().optional().describe('Max matches (default 20)'),
      },
    },
    async (args) => handleToolCall('search_entities', args),
  );

  server.registerTool(
    'list_entities',
    {
      description:
        'List entities or complex types with their keys and property counts. Use search_entities when the model is large.',
      inputSchema: {
        kind: z
          .enum(['all', 'entity', 'complex'])
          .optional()
          .describe('Filter by kind (default "all")'),
        ...paginationSchema,
      },
    },
    async (args) => handleToolCall('list_entities', args),
  );

  server.registerTool(
    'get_entity_details',
    {
      description:
        'Get the full schema for an entity or complex type: inheritance chain, keys, effective (inherited) properties, navigation properties, resolved enum/type-definition/complex types, annotations, and entity sets. Accepts short or namespace-qualified names.',
      inputSchema: {
        entityName: z.string().describe('Entity name, e.g. "Part" or "PTC.ProdMgmt.Part"'),
      },
    },
    async (args) => handleToolCall('get_entity_details', args),
  );

  server.registerTool(
    'list_entity_sets',
    {
      description:
        'List entity sets with their entity type, CRUD capabilities, and navigation property bindings. Entity set names are what you use in query URLs.',
      inputSchema: {
        ...paginationSchema,
      },
    },
    async (args) => handleToolCall('list_entity_sets', args),
  );

  server.registerTool(
    'get_relationships',
    {
      description:
        'List relationships between entities, optionally filtered to one entity. Useful for planning $expand.',
      inputSchema: {
        entityName: z.string().optional().describe('Only relationships touching this entity'),
        ...paginationSchema,
      },
    },
    async (args) => handleToolCall('get_relationships', args),
  );

  server.registerTool(
    'list_actions',
    {
      description:
        'List schema-level actions (OData operations that may have side effects) with binding and return type info.',
      inputSchema: {
        bound: z.boolean().optional().describe('Filter to bound (true) or unbound (false) actions'),
        ...paginationSchema,
      },
    },
    async (args) => handleToolCall('list_actions', args),
  );

  server.registerTool(
    'list_functions',
    {
      description: 'List schema-level functions (side-effect-free OData operations).',
      inputSchema: {
        bound: z
          .boolean()
          .optional()
          .describe('Filter to bound (true) or unbound (false) functions'),
        ...paginationSchema,
      },
    },
    async (args) => handleToolCall('list_functions', args),
  );

  server.registerTool(
    'get_action_details',
    {
      description:
        'Get an action definition: parameters (with the binding parameter flagged), return type, description, import name, and an invocation sketch.',
      inputSchema: {
        name: z.string().describe('Action name, e.g. "GetPartStructure"'),
        baseUrl: z.string().optional().describe('Service root used in the invocation sketch'),
      },
    },
    async (args) => handleToolCall('get_action_details', args),
  );

  server.registerTool(
    'get_function_details',
    {
      description:
        'Get a function definition: parameters (with the binding parameter flagged), return type, description, import name, and an invocation sketch.',
      inputSchema: {
        name: z.string().describe('Function name, e.g. "GetWindchillMetaInfo"'),
        baseUrl: z.string().optional().describe('Service root used in the invocation sketch'),
      },
    },
    async (args) => handleToolCall('get_function_details', args),
  );

  server.registerTool(
    'list_enums',
    {
      description:
        'List enum types (with members) and type definitions. Use these to format filter literals correctly.',
      inputSchema: {},
    },
    async (args) => handleToolCall('list_enums', args),
  );

  server.registerTool(
    'build_query',
    {
      description:
        'Build an OData V4 GET query URL from filters, $select, $expand, $orderby, paging, $count, and $search. Literals are typed from the loaded model. Returns the URL only — it does not execute the request.',
      inputSchema: {
        entitySet: z.string().describe('Entity set name, e.g. "Parts"'),
        baseUrl: z
          .string()
          .optional()
          .describe('Service root, e.g. "https://host/Windchill/servlet/odata/ProdMgmt"'),
        filters: z.array(filterSchema).optional(),
        filterLogic: z
          .enum(['and', 'or'])
          .optional()
          .describe('How to join filters (default "and")'),
        select: z.array(z.string()).optional(),
        expand: z.array(expandNodeSchema).optional(),
        orderBy: z.string().optional().describe('e.g. "number desc"'),
        top: z.number().int().nonnegative().optional(),
        skip: z.number().int().nonnegative().optional(),
        count: z.boolean().optional().describe('Append $count=true'),
        search: z.string().optional().describe('$search value'),
      },
    },
    async (args) => handleToolCall('build_query', args),
  );

  server.registerTool(
    'build_action_invocation',
    {
      description:
        'Build a POST request (URL, JSON body, curl example) to invoke an action. Bound actions require entitySet + keys. Does not execute the request.',
      inputSchema: {
        actionName: z.string().describe('Action name, e.g. "GetPartStructure"'),
        entitySet: z.string().optional().describe('Required for bound actions, e.g. "Parts"'),
        keys: z
          .record(z.string())
          .optional()
          .describe('Key values for the bound resource, e.g. { "ID": "OR:wt.part.WTPart:123" }'),
        parameters: z.record(z.unknown()).optional().describe('Action parameter values'),
        baseUrl: z.string().optional().describe('Service root'),
      },
    },
    async (args) => handleToolCall('build_action_invocation', args),
  );

  server.registerTool(
    'build_function_invocation',
    {
      description:
        'Build a GET request URL to invoke a function with inline parameters. Bound functions require entitySet + keys. Returns the URL and curl example; it does not execute the request.',
      inputSchema: {
        functionName: z.string().describe('Function name, e.g. "GetWindchillMetaInfo"'),
        entitySet: z.string().optional().describe('Required for bound functions, e.g. "Parts"'),
        keys: z
          .record(z.string())
          .optional()
          .describe('Key values for the bound resource, e.g. { "ID": "OR:wt.part.WTPart:123" }'),
        parameters: z.record(z.unknown()).optional().describe('Function parameter values'),
        baseUrl: z.string().optional().describe('Service root'),
      },
    },
    async (args) => handleToolCall('build_function_invocation', args),
  );

  return server;
}
