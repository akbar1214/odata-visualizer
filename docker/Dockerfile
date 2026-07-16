# Stage 1: Build stage
FROM node:20-alpine AS builder

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/backend/package.json ./packages/backend/
COPY packages/frontend/package.json ./packages/frontend/
COPY packages/mcp/package.json ./packages/mcp/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY tsconfig.base.json ./
COPY packages/ ./packages/

# Build shared package first
RUN pnpm --filter @odata-visualizer/shared build

# Build backend
RUN pnpm --filter @odata-visualizer/backend build

# Build frontend
RUN pnpm --filter @odata-visualizer/frontend build

# Build MCP package
RUN pnpm --filter @odata-visualizer/mcp build

# Stage 2: Production stage
FROM node:20-alpine AS runner

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Set working directory
WORKDIR /app

# Copy package files for production
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/backend/package.json ./packages/backend/
COPY packages/mcp/package.json ./packages/mcp/

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy built artifacts
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/backend/dist ./packages/backend/dist
COPY --from=builder /app/packages/frontend/dist ./packages/frontend/dist
COPY --from=builder /app/packages/mcp/dist ./packages/mcp/dist

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3001

# LLM Configuration (configure your LiteLLM proxy)
# ENV OPENAI_BASE_URL=http://your-litellm-proxy:4000/v1
# ENV OPENAI_API_KEY=your-api-key
# ENV OPENAI_MODEL=gpt-4o

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/api/health || exit 1

# Start the server
CMD ["node", "packages/backend/dist/index.js"]
