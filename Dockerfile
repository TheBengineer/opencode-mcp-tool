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

# Install OpenCode CLI (npm package with platform-specific binary)
# lildax is the wrapper script; the actual binary is in the platform-specific optional dep
RUN npm install -g @opencode-ai/cli@1.17.7 && \
    npm install -g @opencode-ai/cli-linux-x64@1.17.7 2>/dev/null || true && \
    ln -sf /usr/local/bin/lildax /usr/local/bin/opencode && \
    npm cache clean --force && \
    rm -rf /root/.npm/_cacache

# Built MCP server from builder stage
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
