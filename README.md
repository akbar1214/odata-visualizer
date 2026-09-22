# OData Visualizer

An interactive web application for visualizing OData metadata as entity-relationship diagrams.

## Features

- **Interactive ER Diagrams** - Zoom, pan, and explore entity relationships visually
- **Large File Support** - Handles OData metadata files up to 100MB with streaming parsing
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

# Build shared package
pnpm --filter @odata-visualizer/shared build
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
│   │       ├── parser.ts         # CSDL parser (used by backend + MCP)
│   │       ├── resolve.ts        # Inheritance/lookup helpers
│   │       └── query.ts          # OData V4 query builder
│   ├── backend/                   # Express API server
│   │   ├── src/
│   │   │   ├── index.ts          # Server entry
│   │   │   ├── routes/
│   │   │   │   └── parse.ts      # Parse endpoints
│   │   │   └── services/
│   │   │       └── xmlParser.ts  # Re-export of shared parser
│   ├── mcp/                       # MCP server for LLM clients
│   │   └── src/
│   │       ├── index.ts          # MCP server entry
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
Health check endpoint.

## MCP Server

`packages/mcp` exposes an MCP server that lets LLM clients explore OData V4 metadata and build request URLs offline (it never calls the service). It understands Windchill-style models — deep inheritance, bound/unbound actions and functions, enums, type definitions, and annotations.

See [packages/mcp/README.md](packages/mcp/README.md) for the tool list and client configuration.

## Usage

1. **Upload a File**: Drag and drop an OData metadata XML file or click to browse
2. **Enter a URL**: Provide the URL to an OData $metadata endpoint
3. **Explore**: Click on entities to view their properties, zoom and pan the diagram
4. **Search**: Use the metadata explorer to search and filter entities

## License

MIT
