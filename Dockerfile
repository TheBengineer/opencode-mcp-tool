FROM node:20-slim AS builder

WORKDIR /app

# Copy package files and install deps (skip prepare hook — build happens below)
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ---- Runtime image ----
FROM node:20-slim

RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install OpenCode CLI (npm package downloads the platform binary on first run)
# lildax is the binary shipper — --version verifies the download is cached
RUN npm install -g @opencode-ai/cli@1.17.7 && \
    lildax --version 2>/dev/null || true

# Copy built MCP server from builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Copy entrypoint
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Expose the MCP server port
EXPOSE 3100

# Mounted workspace volume — OpenCode processes spawned by the MCP server
# will create output files here (inherits CWD from parent process)
RUN mkdir -p /workspace

ENV OPENCODE_MODEL=""
ENV ANTHROPIC_API_KEY=""
ENV OPENAI_API_KEY=""
ENV GOOGLE_API_KEY=""

ENTRYPOINT ["docker-entrypoint.sh"]
