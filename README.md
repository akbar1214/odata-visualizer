# OData Visualizer

An interactive web application for visualizing OData metadata as entity-relationship diagrams.

## Features

- **Interactive ER Diagrams** - Zoom, pan, and explore entity relationships visually
- **Large File Support** - Accepts OData metadata files up to 100MB (parsed in memory)
- **Metadata Explorer** - Browse entities, properties, and relationships in detail
- **Auto-Layout** - Automatic diagram layout using ELK.js
- **Multiple Input Methods** - Upload files or fetch from URL
- **MCP Server** - Let LLM clients explore metadata and build OData V4 queries and operation calls (Windchill-friendly)

## Tech Stack

| Component | Technology |
|-----------|------------|
| Frontend | React 18 + TypeScript |
| Build Tool | Vite 5 |
| Diagram | React Flow (@xyflow/react) |
| Layout | ELK.js |
| Styling | Tailwind CSS |
| Backend | Node.js 20 + Express |
| XML Parser | fast-xml-parser |
| MCP Server | Model Context Protocol SDK |
| Package Manager | pnpm |
| Testing | Vitest + Playwright Browser Mode |
| Deployment | Docker |

## Getting Started

### Prerequisites

- Node.js 20+
- pnpm

### Installation

```bash
# Clone the repository
git clone <repository-url>
cd odata-visualizer

# Install dependencies
pnpm install

# Build shared package and MCP server
pnpm --filter @odata-visualizer/shared build
pnpm --filter @odata-visualizer/mcp build
```

### Development

```bash
# Start both frontend and backend in development mode
pnpm dev
```

The application will be available at:
- Frontend: http://localhost:5173
- Backend API: http://localhost:3001

### Testing

```bash
# Run all tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Run type checking
pnpm typecheck
```

### Building for Production

```bash
# Build all packages
pnpm build

# Preview production build
pnpm --filter @odata-visualizer/backend preview
```

### Docker

```bash
# Build container image
pnpm container:build

# Run container
pnpm container:run
```

The application will be available at http://localhost:3001

## Project Structure

```
odata-visualizer/
├── packages/
│   ├── shared/                    # Shared types + CSDL parser
│   │   └── src/
│   │       ├── types.ts          # OData model interfaces
│   │       ├── parser.ts         # CSDL parser (backend + MCP)
│   │       ├── load.ts           # File/URL loading (resolves edmx:Reference)
│   │       ├── resolve.ts        # Inheritance/lookup helpers
│   │       └── query.ts          # OData V4 query builder
│   ├── backend/                   # Express API server
│   │   ├── src/
│   │   │   ├── index.ts          # Server entry
│   │   │   ├── app.ts            # createApp() (routes + auth + MCP mount)
│   │   │   ├── auth.ts           # Optional API bearer auth
│   │   │   ├── mcp.ts            # Streamable HTTP MCP mount at /mcp
│   │   │   ├── routes/
│   │   │   │   ├── parse.ts      # Parse endpoints
│   │   │   │   └── metadata.ts   # Per-session metadata endpoints
│   │   │   └── services/
│   │   │       ├── xmlParser.ts  # Re-export of shared parser
│   │   │       ├── metadataStore.ts # In-memory per-session store shared with MCP
│   │   │       └── urlPolicy.ts  # URL allowlist / SSRF guard
│   ├── mcp/                       # MCP server for LLM clients
│   │   └── src/
│   │       ├── index.ts          # stdio entry point
│   │       ├── server.ts         # createMcpServer(accessors)
│   │       ├── store.ts          # Shared metadata store
│   │       ├── tools.ts          # Tool handlers
│   │       └── metadata-loader.ts
│   └── frontend/                  # React app
│       ├── src/
│       │   ├── main.tsx
│       │   ├── App.tsx
│       │   ├── components/
│       │   │   ├── EntityNode.tsx
│       │   │   ├── RelationshipEdge.tsx
│       │   │   ├── ERDiagram.tsx
│       │   │   ├── MetadataInput.tsx
│       │   │   └── MetadataExplorer.tsx
│       │   ├── hooks/
│       │   ├── services/
│       │   └── utils/
│       └── __tests__/
├── container/
│   └── Containerfile
├── package.json
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

## API Endpoints

### POST /api/parse/file
Upload an OData metadata XML file for parsing.

### POST /api/parse/url
Fetch and parse OData metadata from a URL.

### POST /api/parse/content
Parse raw XML content directly.

### GET /api/health
Health check endpoint (never requires a token).

### GET /api/metadata/current
The parsed model currently in memory (`null` if nothing is loaded). Accepts an optional `?session=<id>` or `X-Metadata-Session` header to read a specific session's model.

### GET /api/metadata
List the models held per session id (no metadata payload).

### DELETE /api/metadata/current
Clear this session's model, or all of them when no session id is supplied.

## Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `PORT` | `3001` | Backend port (also serves MCP) |
| `API_TOKEN` | unset | When set, `/api/*` requires `Authorization: Bearer <token>` |
| `MCP_TOKEN` | unset | When set, `/mcp` requires `Authorization: Bearer <token>` |
| `MCP_ALLOW_LOAD` | unset | `1` exposes `load_metadata` over HTTP (arbitrary file reads / SSRF) |
| `MCP_ALLOWED_HOSTS` | localhost only | Allowed `Host` header values for `/mcp` |
| `METADATA_URL_ALLOWLIST` | unset | Hosts `/api/parse/url` may fetch (`*.example.com` wildcards allowed) |
| `METADATA_URL_BLOCK_PRIVATE` | `1` | `0` allows fetching private/loopback metadata URLs (needed for internal services) |
| `ODATA_BACKEND_URL` | `http://localhost:3001` | Backend used by the standalone stdio MCP server |

## MCP Server

The backend hosts an MCP server over Streamable HTTP at `http://localhost:3001/mcp`, so `pnpm dev` brings it up alongside the app. It shares the backend's metadata store: **whatever file you upload in the UI is immediately usable by MCP tools** (no `load_metadata` call). Each browser tab keeps its own model, so concurrent sessions don't overwrite each other. It understands Windchill-style models — deep inheritance, bound/unbound actions and functions, enums, type definitions, annotations, and `edmx:Reference` multi-file models.

Metadata can be built with `$apply` (groupby/aggregate), and the query builder warns about unknown property names instead of emitting a URL the service will reject.

A standalone stdio server is also available (`packages/mcp`), and can preload the UI's upload via `ODATA_BACKEND_URL` or the `load_metadata` tool with `type: "server"`.

See [packages/mcp/README.md](packages/mcp/README.md) for the tool list and client configuration (remote HTTP and local stdio).

## Usage

1. **Upload a File**: Drag and drop an OData metadata XML file or click to browse
2. **Enter a URL**: Provide the URL to an OData $metadata endpoint
3. **Explore**: Click on entities to view their properties, zoom and pan the diagram
4. **Search**: Use the metadata explorer to search and filter entities

## License

MIT
