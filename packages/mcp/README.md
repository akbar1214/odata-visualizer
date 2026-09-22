# OData Visualizer MCP Server

An MCP (Model Context Protocol) server that lets LLMs explore OData metadata schemas through structured tools.

## How It Works

The MCP server exposes 4 tools that let an LLM understand your OData data model:

| Tool | Description |
|------|-------------|
| `load_metadata` | Load OData metadata from a file path or URL |
| `list_entities` | List all entities with their key properties |
| `get_entity_details` | Get full schema for a specific entity |
| `get_relationships` | List all entity relationships/associations |

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

The server communicates over stdio — do not run it interactively. Configure your MCP client to launch it.

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

4. **Understand relationships:**
   > "How are Orders and Customers connected?"

## Development

```bash
# Type check
pnpm mcp:typecheck

# Run tests
pnpm --filter @odata-visualizer/mcp test

# Rebuild after changes
pnpm mcp:build
```

## Project Structure

```
packages/mcp/
├── src/
│   ├── index.ts           # MCP server entry point (registerTool wiring)
│   ├── tools.ts           # Tool handlers and formatters
│   └── metadata-loader.ts # File/URL loading + shared CSDL parser import
├── __tests__/             # Vitest tests + fixtures
├── package.json
└── tsconfig.json
```

The CSDL parser itself lives in `@odata-visualizer/shared` (`packages/shared/src/parser.ts`) and is shared with the backend API.
