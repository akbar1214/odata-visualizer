# OData Visualizer MCP Server

An MCP (Model Context Protocol) server that lets LLMs explore OData metadata schemas.

## How It Works

The MCP server exposes 15 tools that let an LLM understand an OData V4 model and construct requests against it — without executing them.

> **Shared metadata:** when the server runs inside the backend, it automatically uses whatever file you uploaded in the UI — no `load_metadata` call needed. See [HTTP transport](#http-transport-served-by-the-backend).

### Explore metadata

| Tool | Description |
|------|-------------|
| `load_metadata` | Load metadata from a file path, URL, or the backend (`type: "server"`); returns a summary |
| `get_metadata_status` | Show what is loaded (source, time, counts) |
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
| `build_query` | Build a V4 GET URL from `$filter`, `$select`, `$expand`, `$apply` (groupby/aggregate), `$orderby`, paging, `$count`, `$search` |
| `build_action_invocation` | Build a POST URL + JSON body + curl example for an action |
| `build_function_invocation` | Build a GET URL with inline parameters for a function |

Literals are typed from the loaded model: strings are quoted with `''` escaping, numbers/booleans are bare, enums use `NS.Enum'VALUE'`, and TypeDefinitions are unwrapped to their underlying EDM type. Bound operations require an `entitySet` plus `keys`. Unknown `$select`/`$filter`/`$orderby`/`$expand` names are reported as warnings rather than silently emitted.

## Windchill

Windchill exposes one OData V4 service per domain, e.g.:

```
https://<host>/Windchill/servlet/odata/ProdMgmt/$metadata
```

`load_metadata` parses these models directly (deep `BaseType` inheritance, bound/unbound actions and functions, enums, type definitions, `edmx:Include`/`edmx:Reference` multi-file models, and `PTC.*` / `Capabilities.*` annotations). A synthetic Windchill-like model is used by the test suite at `packages/shared/__tests__/fixtures/windchill-prodmgmt.xml`.

Multi-file models: when metadata is loaded from a file or URL, referenced documents are resolved relative to it automatically. References that cannot be loaded are listed by `get_metadata_status` instead of failing the parse.

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

## HTTP transport (served by the backend)

When you run the backend (`pnpm dev` or `pnpm start`), it hosts the MCP server over Streamable HTTP at `http://localhost:3001/mcp` and **shares its metadata store with the upload UI**. Upload a file at the frontend and MCP tools can use it immediately — `load_metadata` is not required.

Each browser tab keeps its own model (scoped by a session id), so concurrent uploads don't overwrite each other; MCP always sees the most recently uploaded one.

```bash
pnpm dev            # backend + frontend; MCP comes up with the backend
curl -s http://localhost:3001/api/metadata/current   # what MCP currently sees
curl -s http://localhost:3001/api/metadata           # per-session model list
```

Configuration:

| Env var | Default | Purpose |
|---------|---------|---------|
| `PORT` | `3001` | Backend/MCP port |
| `MCP_TOKEN` | unset | When set, `/mcp` requires `Authorization: Bearer <token>` |
| `MCP_ALLOW_LOAD` | unset | Set to `1` to enable `load_metadata` over HTTP (arbitrary file reads / SSRF) |
| `MCP_ALLOWED_HOSTS` | localhost only | Comma-separated Host header values accepted by `/mcp` (DNS-rebinding protection) |
| `API_TOKEN` | unset | When set, the REST API (`/api/*`) requires `Authorization: Bearer <token>`; `/api/health` stays open |
| `METADATA_URL_ALLOWLIST` | unset | Comma-separated hostnames `/api/parse/url` may fetch (`*.example.com` wildcards allowed) |
| `METADATA_URL_BLOCK_PRIVATE` | `1` | Set to `0` to allow `/api/parse/url` to fetch private/loopback addresses |

For safety, `load_metadata` is **not registered at all** on the HTTP endpoint: metadata comes from uploads, so the tool would only ever be a way to read arbitrary files or make the server fetch arbitrary URLs. A localhost host-header guard is applied to `/mcp`; set `MCP_ALLOWED_HOSTS` if you serve it from another hostname.

## stdio transport (standalone)

You can still run the server over stdio, launched by your MCP client. To use the file uploaded in the UI, either call `load_metadata` with `type: "server"`, or set `ODATA_BACKEND_URL` to preload it at startup.

```bash
pnpm mcp:build
pnpm mcp:start     # or: node packages/mcp/dist/index.js
```

The stdio server does not run on its own — configure your MCP client to launch it.

## MCP Client Configuration

### Remote HTTP (shares UI uploads)

For clients that support remote MCP servers:

```json
{
  "mcpServers": {
    "odata-visualizer": {
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

Start the backend first (`pnpm dev`). Add `"headers": { "Authorization": "Bearer <token>" }` if `MCP_TOKEN` is set.

### Local stdio

For stdio-only clients:

```json
{
  "mcpServers": {
    "odata-visualizer": {
      "command": "node",
      "args": ["/absolute/path/to/odata-visualizer/packages/mcp/dist/index.js"],
      "env": { "ODATA_BACKEND_URL": "http://localhost:3001" }
    }
  }
}
```

`ODATA_BACKEND_URL` is optional; it preloads the currently uploaded metadata. You can also call `load_metadata` with `type: "server"` at any time.

## Example Usage

Once configured, ask your LLM:

1. **Check what's loaded:**
   > "What metadata do you have?" (uses `get_metadata_status`)

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

7. **Load from a file/URL (stdio or `MCP_ALLOW_LOAD=1`):**
   > "Load metadata from https://services.odata.org/V4/OData/OData.svc/$metadata"

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
│   ├── index.ts           # stdio entry point
│   ├── server.ts          # createMcpServer(accessors) — shared by stdio + HTTP
│   ├── store.ts           # MetadataAccessors / createMetadataStore
│   ├── tools.ts           # createToolHandler + tool implementations
│   └── metadata-loader.ts # Metadata loading (file / URL / backend)
├── __tests__/             # (HTTP mount lives in packages/backend/src/mcp.ts)
│   ├── tools.test.ts
│   ├── server.test.ts
│   └── store.test.ts
├── package.json
└── tsconfig.json
```
