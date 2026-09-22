# OData Visualizer MCP Server

An MCP (Model Context Protocol) server that lets LLMs explore OData metadata schemas.

## How It Works

The MCP server exposes 15 tools that let an LLM understand an OData V4 model and construct requests against it — without executing them.

### Explore metadata

| Tool | Description |
|------|-------------|
| `load_metadata` | Load OData metadata from a file path or URL; returns a summary |
| `search_entities` | Search types by name, label, property, or annotation text |
| `list_entities` | List entities / complex types (paged, filter by kind) |
| `get_entity_details` | Full schema for a type: inheritance, effective properties, enums, entity sets |
| `list_entity_sets` | List entity sets with CRUD capabilities and navigation bindings |
| `get_relationships` | List relationships (optionally for one entity) |
| `list_actions` / `get_action_details` | List/describe schema-level actions |
| `list_functions` / `get_function_details` | List/describe schema-level functions |
| `list_enums` | List enum types and type definitions |

### Build requests (offline — no HTTP is performed)

| Tool | Description |
|------|-------------|
| `build_query` | Build a V4 GET URL from `$filter`, `$select`, `$expand`, `$orderby`, paging, `$count`, `$search` |
| `build_action_invocation` | Build a POST URL + JSON body + curl example for an action |
| `build_function_invocation` | Build a GET URL with inline parameters for a function |

Literals are typed from the loaded model: strings are quoted with `''` escaping, numbers/booleans are bare, enums use `NS.Enum'VALUE'`, and TypeDefinitions are unwrapped to their underlying EDM type. Bound operations require an `entitySet` plus `keys`.

## Windchill

Windchill exposes one OData V4 service per domain, e.g.:

```
https://<host>/Windchill/servlet/odata/ProdMgmt/$metadata
```

`load_metadata` parses these models directly (deep `BaseType` inheritance, bound/unbound actions and functions, enums, type definitions, and `PTC.*` / `Capabilities.*` annotations). A synthetic Windchill-like model is used by the test suite at `packages/shared/__tests__/fixtures/windchill-prodmgmt.xml`.

Typical offline workflow:

1. `load_metadata` with the `$metadata` URL (or a saved copy).
2. `search_entities` → `get_entity_details` to learn the shapes.
3. `list_entity_sets` to find the set name.
4. `build_query` / `build_action_invocation` / `build_function_invocation` to produce the request.

Authentication (basic, bearer, or SSO) and execution are intentionally out of scope — the server never calls the service.

## Prerequisites

- Node.js 20+
- pnpm
- An MCP-compatible client (Claude Desktop, Cursor, Windsurf, etc.)

## Installation

```bash
# From the monorepo root
pnpm install
pnpm mcp:build
```

## Providing Metadata

The `load_metadata` tool accepts two types of sources:

### Option 1: URL (fetch from OData service)

Provide the `$metadata` endpoint URL of any OData service:

```
source: https://services.odata.org/V4/OData/OData.svc/$metadata
type: url
```

### Option 2: Local file path

Point to a local CSDL/XML metadata file:

```
source: /path/to/your/metadata.xml
type: file
```

You can export metadata from SAP, Dynamics, or any OData service by navigating to `<service-url>/$metadata` and saving the XML.

## Running the Server

```bash
# Build and start
pnpm mcp:build
pnpm mcp:start

# Or directly
node packages/mcp/dist/index.js
```

The server communicates over stdio — do not run it directly. Instead, configure your MCP client to launch it.

## MCP Client Configuration

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "odata-visualizer": {
      "command": "node",
      "args": ["/absolute/path/to/odata-visualizer/packages/mcp/dist/index.js"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "odata-visualizer": {
      "command": "node",
      "args": ["/absolute/path/to/odata-visualizer/packages/mcp/dist/index.js"]
    }
  }
}
```

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "odata-visualizer": {
      "command": "node",
      "args": ["/absolute/path/to/odata-visualizer/packages/mcp/dist/index.js"]
    }
  }
}
```

## Example Usage

Once configured, ask your LLM:

1. **Load a service:**
   > "Load metadata from https://services.odata.org/V4/OData/OData.svc/$metadata"

2. **Explore the schema:**
   > "What entities are available?"

3. **Get entity details:**
   > "Show me the Product entity schema"

4. **Inspect relationships:**
   > "How are Orders and Customers related?"

5. **Build a query:**
   > "Give me released parts over 10, with their documents, ordered by number"

6. **Build an operation call:**
   > "Show me how to call GetPartStructure for part 123"

## Development

```bash
# Type check
pnpm mcp:typecheck

# Run tests
pnpm --filter @odata-visualizer/mcp test
```

## Project Structure

```
packages/mcp/
├── src/
│   ├── index.ts           # MCP server entry point
│   ├── tools.ts           # Tool definitions and handlers
│   └── metadata-loader.ts # Metadata loading from file/URL
├── __tests__/
│   └── tools.test.ts      # Tool handler tests
├── package.json
└── tsconfig.json
```
