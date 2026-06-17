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

# App files go to a stable location
WORKDIR /app

# Install OpenCode CLI (npm package downloads the platform binary on first run)
# lildax is the binary shipper — --version verifies the download is cached
RUN npm install -g @opencode-ai/cli@1.17.7 && \
    lildax --version 2>/dev/null || true

# Copy built MCP server from builder stage to /app (absolute paths)
COPY --from=builder /app/dist /app/dist
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/package.json /app/

# Copy entrypoint
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Switch WORKDIR to /workspace — spawned OpenCode processes inherit this CWD
# so their output files land in the mounted volume, visible on the host.
WORKDIR /workspace

RUN mkdir -p /workspace

# Expose the MCP server port
EXPOSE 3100

ENV OPENCODE_MODEL=""
ENV ANTHROPIC_API_KEY=""
ENV OPENAI_API_KEY=""
ENV GOOGLE_API_KEY=""

ENTRYPOINT ["docker-entrypoint.sh"]
