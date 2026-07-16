# OData Visualizer MCP Server

An MCP (Model Context Protocol) server that allows LLMs to explore OData metadata schemas and generate OData queries from natural language questions.

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

4. **Generate a query:**
   > "How do I get all products that cost more than $50?"

The LLM will call the tools to understand the schema, then generate the appropriate OData query like:

```
GET /Products?$filter=Price gt 50
```

## Deployment with Docker

The application can be deployed as a single Docker container that includes the web UI with an embedded AI chat panel.

### Environment Variables

Configure the LLM provider via environment variables. The application uses an OpenAI-compatible API, so you can use LiteLLM as a proxy to any LLM provider.

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENAI_BASE_URL` | Base URL for the LLM API (LiteLLM proxy) | `http://localhost:4000/v1` |
| `OPENAI_API_KEY` | API key for authentication | `sk-placeholder` |
| `OPENAI_MODEL` | Model name to use | `gpt-4o` |
| `PORT` | Server port | `3001` |

### LiteLLM Proxy Setup

If you're using LiteLLM as a proxy, configure it to route to your preferred LLM provider:

```yaml
# litellm_config.yaml
model_list:
  - model_name: gpt-4o
    litellm_params:
      model: openai/gpt-4o
      api_key: os.environ/OPENAI_API_KEY
  - model_name: claude-3-opus
    litellm_params:
      model: anthropic/claude-3-opus-20240229
      api_key: os.environ/ANTHROPIC_API_KEY
```

Start LiteLLM:

```bash
litellm --config litellm_config.yaml --port 4000
```

### Running with Docker

```bash
# Build the image
docker build -f docker/Containerfile -t odata-visualizer .

# Run with LiteLLM proxy
docker run -p 3001:3001 \
  -e OPENAI_BASE_URL=http://host.docker.internal:4000/v1 \
  -e OPENAI_API_KEY=your-api-key \
  -e OPENAI_MODEL=gpt-4o \
  odata-visualizer
```

Or use docker-compose:

```yaml
version: '3.8'
services:
  odata-visualizer:
    build:
      context: .
      dockerfile: docker/Containerfile
    ports:
      - "3001:3001"
    environment:
      - OPENAI_BASE_URL=http://litellm:4000/v1
      - OPENAI_API_KEY=your-api-key
      - OPENAI_MODEL=gpt-4o
    depends_on:
      - litellm

  litellm:
    image: ghcr.io/berriai/litellm:main-latest
    ports:
      - "4000:4000"
    volumes:
      - ./litellm_config.yaml:/app/config.yaml
    command: --config /app/config.yaml
    environment:
      - OPENAI_API_KEY=your-openai-key
      - ANTHROPIC_API_KEY=your-anthropic-key
```

### Using the Web UI

1. Open `http://localhost:3001` in your browser
2. Upload an OData metadata XML file or enter a metadata URL
3. View the interactive ER diagram
4. Click "AI Chat" in the header to open the chat panel
5. Ask questions like:
   - "How do I get all products from Germany?"
   - "What's the relationship between Orders and Customers?"
   - "Show me the top 10 most expensive products"

The AI will generate OData queries based on your uploaded metadata.

## Development

```bash
# Watch mode
cd packages/mcp
npx tsx watch src/index.ts

# Type check
pnpm mcp:typecheck
```

## Project Structure

```
packages/mcp/
├── src/
│   ├── index.ts           # MCP server entry point
│   ├── tools.ts           # Tool definitions and handlers
│   └── metadata-loader.ts # CSDL XML parser
├── package.json
└── tsconfig.json
```
